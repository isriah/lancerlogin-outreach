import { HttpError } from "@lancerlogin/module-sdk/api";
import type { CoreModuleServices } from "@lancerlogin/module-sdk/api";
import { OutreachPublicationDeliveryError, outreachGoogleEventPayload, type OutreachPublicationDelivery, type OutreachPublicationEvent, type OutreachPublicationProvider, type OutreachPublicationProviders } from "./outreach-publication.ts";

type DiscordScheduledEvent = { id?: string; entity_metadata?: { location?: string } };

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function sha256(value: string): Promise<string> {
  return btoa(String.fromCharCode(...await digest(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256Hex(value: string): Promise<string> {
  return [...await digest(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ProviderError = { message?: unknown; status?: unknown; retryAfterMs?: unknown; retryable?: unknown; discordCode?: unknown };
const fields = (error: unknown): ProviderError => error && typeof error === "object" ? error as ProviderError : {};
const errorMessage = (error: unknown) => typeof fields(error).message === "string" ? String(fields(error).message) : "Publication delivery failed";
// Discord's error code when a server already has its 100 scheduled events.
const discordScheduledEventLimit = 30038;
export const outreachDiscordEventLimitMessage = "Discord's limit of 100 scheduled events for this server is reached. End or delete some Discord events, then retry.";

export const outreachDiscordRateLimitMessage = "Discord is rate limiting publishing. LancerLogin will try again automatically.";

/**
 * Classify a Discord failure as Core classifies meeting calendar failures. From module SDK 1.3.0 Core's client reports a
 * rate limit as `providerStatus` 429 and its wait through `retryAfterMs`; older Cores raise their own rate limit error,
 * whose text says "rate limiting" and which carries `retryAfterMs` itself. Core's text named the wrong operation and froze
 * its wait, so Outreach stores its own message and shows when it retries instead. A missing permission (403) arrives as a
 * 502 that names the permission; Discord's other refusals carry their status.
 */
export function outreachDiscordDeliveryError(error: unknown, providerStatus: number | undefined, retryAfterMs?: number): OutreachPublicationDeliveryError {
  const value = fields(error); const message = errorMessage(error);
  if (providerStatus === 429 || /rate limiting/i.test(message)) return new OutreachPublicationDeliveryError(outreachDiscordRateLimitMessage, { retry: true, stopsBatch: true, rateLimited: true, retryAfterMs: retryAfterMs ?? (typeof value.retryAfterMs === "number" ? value.retryAfterMs : 60_000) });
  if (providerStatus === 403 || providerStatus === undefined && value.status === 502 && /^Discord denied/.test(message)) return new OutreachPublicationDeliveryError(message, { retry: false, stopsBatch: true });
  if (value.discordCode === discordScheduledEventLimit || /maximum number of (guild )?scheduled events/i.test(message)) return new OutreachPublicationDeliveryError(outreachDiscordEventLimitMessage, { retry: false });
  if (providerStatus !== undefined && providerStatus >= 400 && providerStatus < 500) return new OutreachPublicationDeliveryError(message, { retry: false });
  if (typeof value.status === "number" && value.status >= 400 && value.status < 500) return new OutreachPublicationDeliveryError(message, { retry: false });
  return new OutreachPublicationDeliveryError(message, { retry: true });
}

/** Classify a Google Calendar failure. Core's provider errors say whether they are retryable and how long Google asked to wait. */
export function outreachGoogleDeliveryError(error: unknown, providerStatus: number | undefined): OutreachPublicationDeliveryError {
  const value = fields(error); const message = errorMessage(error); const retryAfterMs = typeof value.retryAfterMs === "number" ? value.retryAfterMs : undefined;
  if (providerStatus === 429) return new OutreachPublicationDeliveryError(message, { retry: true, stopsBatch: true, rateLimited: true, retryAfterMs: retryAfterMs ?? 60_000 });
  if (value.retryable === false || typeof value.status === "number" && value.status >= 400 && value.status < 500) return new OutreachPublicationDeliveryError(message, { retry: false });
  return new OutreachPublicationDeliveryError(message, { retry: true, retryAfterMs });
}

/** Outreach event publication through the shared Google Calendar and Discord connections. */
export function outreachPublicationProviders(services: CoreModuleServices): OutreachPublicationProviders {
  const { googleCalendar, discord } = services;
  // Module SDK 1.3.0 adds retryAfterMs; with SDK 1.2.0 it is absent and the classification falls back to a minute.
  const discordRetryAfter = (discord as typeof discord & { retryAfterMs?: (error: unknown) => number | undefined }).retryAfterMs;
  const classified = async <T>(provider: OutreachPublicationProvider, work: () => Promise<T>) => {
    try { return await work(); }
    catch (error) { throw provider === "discord" ? outreachDiscordDeliveryError(error, discord.providerStatus(error), discordRetryAfter?.call(discord, error)) : outreachGoogleDeliveryError(error, googleCalendar.providerStatus(error)); }
  };
  const publish = async (provider: OutreachPublicationProvider, event: OutreachPublicationEvent, savedExternalId?: string, delivery?: OutreachPublicationDelivery) => {
    if (provider === "google_calendar") {
      const { accessToken, calendarId } = await googleCalendar.access(); if (!calendarId) throw new HttpError(409, "Select a writable Google Calendar before publication"); const eventId = savedExternalId ?? `llo${(await sha256Hex(`outreach:primary:${event.activityId}`)).slice(0, 48)}`;
      const path = googleCalendar.operationPath(calendarId, eventId); const payload = outreachGoogleEventPayload(event);
      if (savedExternalId) try { await googleCalendar.request(accessToken, path, { method: "PATCH", body: JSON.stringify(payload) }); return eventId; } catch (error) { if (googleCalendar.providerStatus(error) !== 404) throw error; }
      try { await googleCalendar.request(accessToken, googleCalendar.operationPath(calendarId), { method: "POST", body: JSON.stringify({ id: eventId, ...payload }) }); }
      catch (error) { if (googleCalendar.providerStatus(error) === 409) await googleCalendar.request(accessToken, path, { method: "PATCH", body: JSON.stringify(payload) }); else throw error; }
      return eventId;
    }
    const client = await discord.client(); if (event.title.length > 100) throw new HttpError(400, "Discord event names are limited to 100 characters");
    const correlation = `LancerLogin Outreach · ${(await sha256(`outreach:primary:${event.activityId}`)).slice(0, 24)}`;
    const description = [event.description, event.location ? `Location: ${event.location}` : "", "Published from LancerLogin Outreach."].filter(Boolean).join("\n");
    if (description.length > 1_000) throw new HttpError(400, "Discord event descriptions are limited to 1,000 characters");
    const payload = { name: event.title, description, privacy_level: 2, entity_type: 3, scheduled_start_time: event.startsAt, scheduled_end_time: event.endsAt, entity_metadata: { location: correlation } };
    let eventId = savedExternalId;
    if (eventId) try { await client.request(`/guilds/${client.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) }); return eventId; } catch (error) { if (discord.providerStatus(error) !== 404) throw error; eventId = undefined; }
    // A first attempt with no saved event cannot have created one, so it creates directly and saves Discord a request.
    // A retry lists the server's events first, so an event whose creation was not recorded is updated, not duplicated.
    if (!savedExternalId && delivery?.firstAttempt) return create(client, payload);
    const listed = await client.request<DiscordScheduledEvent[]>(`/guilds/${client.guildId}/scheduled-events`, { method: "GET" });
    if (!Array.isArray(listed.body)) throw new HttpError(502, "Discord did not return a scheduled event list");
    eventId = listed.body.find((item) => item.entity_metadata?.location === correlation)?.id;
    if (eventId) { await client.request(`/guilds/${client.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) }); return eventId; }
    return create(client, payload);
  };
  const create = async (client: Awaited<ReturnType<typeof discord.client>>, payload: Record<string, unknown>) => {
    const created = await client.request(`/guilds/${client.guildId}/scheduled-events`, { method: "POST", body: JSON.stringify(payload) }); const eventId = String(created.body.id ?? "");
    if (!eventId) throw new HttpError(502, "Discord did not return a scheduled event ID");
    return eventId;
  };
  const remove = async (provider: OutreachPublicationProvider, externalId: string) => {
    if (provider === "google_calendar") {
      const { accessToken, calendarId } = await googleCalendar.access();
      if (!calendarId) throw new HttpError(409, "Select a writable Google Calendar before publication cleanup");
      try { await googleCalendar.request(accessToken, googleCalendar.operationPath(calendarId, externalId), { method: "DELETE" }); }
      catch (error) { if (![404, 410].includes(googleCalendar.providerStatus(error) ?? 0)) throw error; }
      return;
    }
    const client = await discord.client();
    try { await client.request(`/guilds/${client.guildId}/scheduled-events/${externalId}`, { method: "DELETE" }); }
    catch (error) { if (discord.providerStatus(error) !== 404) throw error; }
  };
  return {
    async status() { return { google_calendar: await googleCalendar.ready(), discord: await discord.ready() }; },
    publish: (provider, event, savedExternalId, delivery) => classified(provider, () => publish(provider, event, savedExternalId, delivery)),
    remove: (provider, externalId) => classified(provider, () => remove(provider, externalId)),
  };
}

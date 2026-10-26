import { HttpError } from "@lancerlogin/module-sdk/api";
import type { CoreModuleServices } from "@lancerlogin/module-sdk/api";
import { outreachGoogleEventPayload, type OutreachPublicationEvent, type OutreachPublicationProvider, type OutreachPublicationProviders } from "./outreach-publication.ts";

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

/** Outreach event publication through the shared Google Calendar and Discord connections. */
export function outreachPublicationProviders(services: CoreModuleServices): OutreachPublicationProviders {
  const { googleCalendar, discord } = services;
  return {
    async status() { return { google_calendar: await googleCalendar.ready(), discord: await discord.ready() }; },
    async publish(provider: OutreachPublicationProvider, event: OutreachPublicationEvent, savedExternalId?: string) {
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
      const listed = await client.request<DiscordScheduledEvent[]>(`/guilds/${client.guildId}/scheduled-events`, { method: "GET" });
      if (!Array.isArray(listed.body)) throw new HttpError(502, "Discord did not return a scheduled event list");
      eventId = listed.body.find((item) => item.entity_metadata?.location === correlation)?.id;
      if (eventId) { await client.request(`/guilds/${client.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) }); return eventId; }
      const created = await client.request(`/guilds/${client.guildId}/scheduled-events`, { method: "POST", body: JSON.stringify(payload) }); eventId = String(created.body.id ?? "");
      if (!eventId) throw new HttpError(502, "Discord did not return a scheduled event ID");
      return eventId;
    },
    async remove(provider: OutreachPublicationProvider, externalId: string) {
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
    },
  };
}

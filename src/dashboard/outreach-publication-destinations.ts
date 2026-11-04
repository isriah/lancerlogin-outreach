// Text and state for the automatic publication card on Settings > Outreach > General, kept apart from its React so the
// plugin's tests can check them.

export type PublicationProvider = "google_calendar" | "discord";
export type PublicationDestination = { provider: PublicationProvider; configured: boolean; automatic: boolean; waiting: number; failed: number; latestProblem: { message: string; activityTitle: string; at: string } | null };
export type PublicationDestinations = { revision: number; destinations: PublicationDestination[] };
export type BackfillPage = { selected: number; queued: number; skipped: number; failed: number; nextCursor: string | null; limit: number };

export const publicationProviderLabels: Record<PublicationProvider, string> = { google_calendar: "Google Calendar", discord: "Discord" };
// Discord first: it is the destination members see.
export const publicationProviderOrder: PublicationProvider[] = ["discord", "google_calendar"];
export const integrationsHref = "/settings/integrations";

export const switchLabel = (provider: PublicationProvider) => `Publish Events to ${publicationProviderLabels[provider]} automatically`;
export const notSetUpText = "Not set up. Set it up in";
export const integrationsLinkText = "Settings > Integrations";
export const deliveryText = (destination: Pick<PublicationDestination, "waiting" | "failed">) => `${destination.waiting} waiting · ${destination.failed} need another attempt`;
export const latestProblemText = (problem: NonNullable<PublicationDestination["latestProblem"]>) => `Latest problem: ${problem.message} (${problem.activityTitle})`;
export const switchNotice = (provider: PublicationProvider, automatic: boolean) => `${publicationProviderLabels[provider]}: automatic Event publication is ${automatic ? "on" : "off"}.`;
export const backfillButtonText = "Publish upcoming Events";
export const backfillHelp = "Queues active Events that have not ended yet, up to 100, to each destination that is on. Events already published or waiting there are skipped.";
export const noBackfillDestinationText = "Turn on a set-up destination to publish upcoming Events.";

/** Destinations Publish upcoming Events sends to: switched on and set up. */
export const backfillDestinations = (status: PublicationDestinations) => publicationProviderOrder.filter((provider) => status.destinations.some((item) => item.provider === provider && item.automatic && item.configured));

export function listText(labels: string[]) { return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`; }

export const backfillConfirmText = (providers: PublicationProvider[]) => `Publish upcoming Events to ${listText(providers.map((provider) => publicationProviderLabels[provider]))} now? Up to 100 active Events that have not ended yet are queued. Events already published or waiting there are skipped.`;

export function backfillResultText(total: Omit<BackfillPage, "nextCursor" | "limit">) {
  const parts = [`${total.queued} queued`, total.skipped ? `${total.skipped} skipped` : "", total.failed ? `${total.failed} could not be queued` : ""].filter(Boolean);
  return `Publish upcoming Events: ${parts.join(", ")}. ${total.selected} upcoming Event${total.selected === 1 ? "" : "s"} checked.${total.queued ? " Queued Events publish within 5 minutes." : ""}`;
}

/** The destination status response, or undefined when it is not one (an older API, or a stand-in that answers every route). */
export function parsePublicationDestinations(value: unknown): PublicationDestinations | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { revision, destinations } = value as { revision?: unknown; destinations?: unknown };
  if (!Number.isSafeInteger(revision) || !Array.isArray(destinations)) return undefined;
  const valid = destinations.every((item) => item && typeof item === "object" && publicationProviderOrder.includes((item as PublicationDestination).provider) && typeof (item as PublicationDestination).configured === "boolean" && typeof (item as PublicationDestination).automatic === "boolean" && Number.isSafeInteger((item as PublicationDestination).waiting) && Number.isSafeInteger((item as PublicationDestination).failed));
  return valid ? value as PublicationDestinations : undefined;
}

/** A switch is disabled while its destination is not set up, unless it is still on: it can always be turned off. */
export const switchDisabled = (destination: PublicationDestination, busy: boolean) => busy || !destination.configured && !destination.automatic;

/** When a failed delivery retries by itself, in the viewer's local time. */
export function retryingAtText(nextAttemptAt: string | null | undefined, locale?: string) {
  const at = nextAttemptAt ? Date.parse(nextAttemptAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return `Retrying automatically at ${new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

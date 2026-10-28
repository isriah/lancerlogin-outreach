// The parts of @lancerlogin/module-sdk/api that Outreach logic uses at runtime. Core provides the real SDK in a composed
// build; this stand-in lets the plugin's own tests run without a Core checkout.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

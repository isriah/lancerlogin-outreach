// Resolve @lancerlogin/module-sdk and @lancerlogin/module-sdk/api to the plugin's test stand-ins. Import this module before
// importing plugin sources.
import { registerHooks } from "node:module";

const stubs = {
  "@lancerlogin/module-sdk/api": new URL("./module-sdk-stub.mjs", import.meta.url).href,
  "@lancerlogin/module-sdk": new URL("./module-sdk-civil-time-stub.mjs", import.meta.url).href,
};
registerHooks({ resolve: (specifier, context, next) => Object.hasOwn(stubs, specifier) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context) });

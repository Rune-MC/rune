import { registerHooks } from "node:module";

// Resolve the source tree the way Paper links installed Runebook libraries.
registerHooks({
  resolve(specifier, context, next) {
    const name = /^@rune\/([a-z-]+)$/.exec(specifier)?.[1];
    return next(name ? new URL(`../${name}/index.ts`, import.meta.url).href : specifier, context);
  },
});

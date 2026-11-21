import { handle, type Env } from "./registry";

export default {
  fetch: (req, env) => handle(req, env, (input, init) => fetch(input, init)),
} satisfies ExportedHandler<Env>;

// A shared chunk, the shape a bundler emits when two entry modules import one
// thing. Neither entry declares it and neither has to: the build discovers it
// and writes it into `workers[].modules` for both of them.
export const ok = () => new Response("ok");

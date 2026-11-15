// Solid's reactive build, which the follower's test runs on (Bun resolves
// `solid-js` to the server build, which never re-runs a computation): the
// same API as `solid-js`.
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}

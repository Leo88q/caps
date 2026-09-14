// Browser shim for `https` — @switchboard-xyz/common builds an axios instance
// with an https.Agent; in the browser axios uses XHR/fetch and ignores it.
export class Agent {
  constructor(_opts?: unknown) {}
}
export default { Agent };

/**
 * Testing mode: the Developer app opens straight into the console with the demo developer account
 * (no email, no code), as long as the server runs in demo mode. Real developer accounts still sign in
 * with their email and a code; turning demo mode off on the server closes this door by itself.
 */
export const openConsole = {
  /** Set while the one-tap sign-in runs, so the bind step completes without a second tap. */
  autoBind: false,
  /** Tried once per app start: after a sign-out the person chooses again. */
  tried: false,
};

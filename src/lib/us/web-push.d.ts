/**
 * web-push.d.ts — types for a package that ships none.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * `web-push@3.6.7` is plain CommonJS with no `types` field and no bundled
 * declarations, so `await import('web-push')` is a hard error under this
 * project's compiler settings. There were three ways out and this is the least
 * bad one.
 *
 *   NOT `@types/web-push`   — a fourth-party package describing an entire API
 *                             surface we use one function of, kept in step with
 *                             the real one by nobody in particular.
 *   NOT `@ts-ignore`        — that silences the checker at the one line where
 *                             getting the call shape wrong is invisible until it
 *                             is a notification that never arrived.
 *   THIS                    — the four things push.ts actually touches, written
 *                             down. A future upgrade that changes one of them is
 *                             a type error here instead of a runtime one on her
 *                             phone.
 *
 * It is DELIBERATELY INCOMPLETE. `setVapidDetails`, `generateVAPIDKeys`,
 * `encrypt`, `getVapidHeaders`, `setGCMAPIKey` and `generateRequestDetails` are
 * all real and all absent, because nothing here calls them and a declaration for
 * a function nobody calls is a claim nobody checks. If you need one, add it and
 * verify the signature against node_modules/web-push/src/ rather than from
 * memory.
 *
 * ---------------------------------------------------------------------------
 * THE `default` EXPORT IS THE REAL SHAPE, AND THAT IS NOT A STYLE CHOICE
 *
 * The package ends with `module.exports = { ..., sendNotification:
 * webPush.sendNotification.bind(webPush) }`. Because that last one is a `.bind()`
 * call rather than a plain identifier, Node's CommonJS named-export detection
 * cannot see it — verified: under `await import('web-push')`, `mod.default` is
 * the exports object and `mod.sendNotification` is `undefined`, while
 * `mod.WebPushError` (a bare reference) does come through.
 *
 * So `default` is where the function lives, and push.ts reads it from there with
 * a fallback for the other shape rather than betting on one.
 */
declare module 'web-push' {
  /** Exactly the three fields the encryption needs out of a PushSubscription. */
  export interface WebPushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  /** The subset of options push.ts sets. See web-push-lib.js's validOptionKeys. */
  export interface WebPushOptions {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    /** Seconds a push service may hold an undelivered notification. */
    TTL?: number;
    /** Socket timeout in milliseconds. */
    timeout?: number;
    /** <=32 URL-safe base64 characters, or the library throws. */
    topic?: string;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
  }

  export interface WebPushResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  /**
   * REJECTS on any non-2xx, with a WebPushError carrying `statusCode`. That
   * rejection is the only way a dead subscription is ever discovered, so the
   * declaration says `Promise` and push.ts reads `statusCode` off the error.
   */
  export interface WebPushModule {
    sendNotification(
      subscription: WebPushSubscription,
      payload?: string | Buffer | null,
      options?: WebPushOptions,
    ): Promise<WebPushResult>;
  }

  const webpush: WebPushModule;
  export default webpush;
}

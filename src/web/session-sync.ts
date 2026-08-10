const CHANNEL_NAME = "pi-agent-session-list";
const INVALIDATE_MESSAGE = "sessions-invalidated";

export interface SessionListSync {
  notify: () => void;
  close: () => void;
}

/**
 * 使用浏览器同源广播同步不同标签页的会话列表。
 */
export function createSessionListSync(onInvalidate: () => void): SessionListSync {
  if (typeof BroadcastChannel === "undefined") {
    return { notify: () => undefined, close: () => undefined };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    if (event.data === INVALIDATE_MESSAGE) {
      onInvalidate();
    }
  };
  return {
    notify: () => channel.postMessage(INVALIDATE_MESSAGE),
    close: () => channel.close(),
  };
}

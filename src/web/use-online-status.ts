import { useEffect, useState } from "react";

/**
 * 订阅浏览器在线状态，供配置页面在离线时禁用写操作。
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, []);
  return online;
}

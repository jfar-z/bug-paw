import { useState } from "react";

interface AvatarAgent {
  profile: {
    id: string;
    name: string;
    avatar: { kind: "initial"; value: string } | { kind: "image"; revision: string; mediaType: string };
  };
}

interface AgentAvatarProps {
  agent: AvatarAgent;
  className?: string;
  label?: string;
}

/**
 * 使用 Agent 配置渲染图片头像，并在图片不可用时回退到文字头像。
 */
export function AgentAvatar({ agent, className, label }: AgentAvatarProps) {
  const [failed, setFailed] = useState(false);
  const { profile } = agent;
  const fallback = profile.avatar.kind === "initial"
    ? profile.avatar.value
    : profile.name.trim().slice(0, 1).toUpperCase() || "A";
  if (profile.avatar.kind === "image" && !failed) {
    const source = `/api/v1/agents/${encodeURIComponent(profile.id)}/avatar?v=${encodeURIComponent(profile.avatar.revision)}`;
    return <img className={className} src={source} alt={label ?? ""} onError={() => setFailed(true)} />;
  }
  return <span className={className} aria-label={label}>{fallback}</span>;
}

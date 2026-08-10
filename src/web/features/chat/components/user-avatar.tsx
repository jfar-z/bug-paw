import type { IdentityPreview } from "../../../pages/chat-page";

/** 渲染用户头像；未上传图片时保留原有首字母占位。 */
export function UserAvatar({ identity, className }: { identity: IdentityPreview; className: string }) {
  if (identity.avatar) {
    return <img className={className} src={`/api/v1/profile/avatar?v=${encodeURIComponent(identity.avatar.revision)}`} alt="" />;
  }
  return <span className={className}>{identity.avatarText}</span>;
}

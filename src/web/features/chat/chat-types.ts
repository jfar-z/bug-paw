/** 聊天页面和聊天组件共享的轻量身份投影。 */
export interface IdentityPreview {
  displayName: string;
  avatarText: string;
  avatar?: { kind: "image"; revision: string };
}

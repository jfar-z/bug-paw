import type { QuestionResponseEntry } from "../../../conversation-timeline";
import { QuestionResponseCard } from "../../../components/question-response-card";
import type { IdentityPreview } from "../../../pages/chat-page";
import { UserAvatar } from "./user-avatar";

interface QuestionResponseMessageProps {
  entry: QuestionResponseEntry;
  profileIdentity: IdentityPreview;
}

/** 使用用户消息视觉归属承载只读的结构化回答卡片。 */
export function QuestionResponseMessage({ entry, profileIdentity }: QuestionResponseMessageProps) {
  return <article
    className="message-row is-user question-response-message"
    data-question-resolution-id={entry.resolution.resolutionId}
  >
    <div className="message-meta">
      <strong>{profileIdentity.displayName}</strong>
      <UserAvatar identity={profileIdentity} className="message-avatar is-user-avatar" />
    </div>
    <div className="user-message-body">
      <div className="message-content">
        <QuestionResponseCard
          pendingQuestion={entry.pendingQuestion}
          resolution={entry.resolution}
        />
      </div>
    </div>
  </article>;
}

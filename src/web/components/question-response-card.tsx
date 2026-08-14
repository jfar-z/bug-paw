import type { QuestionResolution } from "../../shared/question-response-protocol";
import type { PendingQuestionProjection } from "../../shared/session-question-contracts";

interface QuestionResponseCardProps {
  pendingQuestion: PendingQuestionProjection;
  resolution: QuestionResolution;
}

/** 在独立用户消息中展示经过服务端确认的结构化回答。 */
export function QuestionResponseCard({ pendingQuestion, resolution }: QuestionResponseCardProps) {
  const questions = new Map(pendingQuestion.questions.map((question) => [question.id, question]));
  return <section className="question-timeline-card question-response-card" aria-label="用户回答">
    <header>
      <strong>{resolution.status === "submitted" ? "已提交回答" : "已放弃回答"}</strong>
      <span>共 {pendingQuestion.questions.length} 个问题</span>
    </header>
    <div className="question-timeline-card__answers">
      {resolution.answers.map((answer) => {
        const question = questions.get(answer.questionId);
        if (!question) return null;
        const value = answer.kind === "text"
          ? answer.text
          : answer.optionIds
            .map((optionId) => question.options.find((option) => option.id === optionId)?.label)
            .filter((label): label is string => Boolean(label))
            .join("、");
        return <div key={answer.questionId}>
          <span>{question.header}</span>
          <strong>{value || "未回答"}</strong>
        </div>;
      })}
      <span>未回答 {resolution.unansweredQuestionIds.length} 题</span>
    </div>
  </section>;
}

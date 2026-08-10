interface ComingSoonPageProps {
  eyebrow: string;
  title: string;
  description: string;
}

/**
 * 呈现尚未接入数据服务的工作台模块，避免以虚构内容误导用户。
 */
export function ComingSoonPage({ eyebrow, title, description }: ComingSoonPageProps) {
  return (
    <div className="configuration-page coming-soon-page">
      <header className="configuration-page__heading">
        <span className="configuration-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <p className="coming-soon-page__state">COMING SOON</p>
    </div>
  );
}

interface ProductMarkProps {
  compact?: boolean;
}

/**
 * 使用正式猫头资产呈现 BugPaw 产品标识。
 */
export function ProductMark({ compact = false }: ProductMarkProps) {
  return (
    <div className={compact ? "product-mark is-compact" : "product-mark"} aria-label="BugPaw">
      <img
        className="product-mark__image"
        src="/brand/bugpaw/bugpaw-app-icon-brown-paw.png"
        alt=""
        aria-hidden="true"
      />
      {!compact && (
        <span className="product-mark__name">
          Bug<span>Paw</span>
        </span>
      )}
    </div>
  );
}

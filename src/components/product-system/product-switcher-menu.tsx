import type { ComponentType, ComponentPropsWithoutRef } from "react";
import { PRODUCT_CATALOG, type ProductId } from "./product-catalog";
import { ProductPopover } from "./product-popover";
import styles from "./product-system.module.css";

type MenuLink = ComponentType<ComponentPropsWithoutRef<"a"> & { href: string }>;

export function ProductSwitcherMenu({
  currentProduct, brandLabel, paperMotion, dailyReflectionEnabled, workReviewEnabled, LinkComponent, onChoose
}: Readonly<{
  currentProduct: ProductId;
  brandLabel?: string;
  paperMotion?: boolean;
  dailyReflectionEnabled: boolean;
  workReviewEnabled: boolean;
  LinkComponent: MenuLink;
  onChoose?: (id: ProductId) => void;
}>) {
  const current = PRODUCT_CATALOG.find((product) => product.id === currentProduct);
  return (
    <ProductPopover
      className={styles.productSwitcher}
      label={`切换产品，当前为${current?.name ?? "Daily Brief"}`}
      panelClassName={styles.productSwitcherMenu}
      paperMotion={paperMotion}
      trigger={(
        <>
          {!brandLabel && <span aria-hidden="true">DB</span>}
          <b>{brandLabel || current?.name}</b>
          <i aria-hidden="true">⌄</i>
        </>
      )}
      triggerClassName={styles.productSwitcherTrigger}
    >
      <p>切换空间</p>
      <LinkComponent href="/">全部产品</LinkComponent>
      {PRODUCT_CATALOG.map((product) => {
        const enabled = product.id === "date_companion"
          || product.id === "learning_organizer"
          || (product.id === "daily_reflection" && dailyReflectionEnabled)
          || (product.id === "office_review" && workReviewEnabled);
        return product.href && enabled ? (
          <LinkComponent
            aria-current={product.id === currentProduct ? "page" : undefined}
            href={product.href}
            key={product.id}
            onClick={() => onChoose?.(product.id)}
          >
            <span aria-hidden="true">{product.mark}</span>
            <span><b>{product.name}</b>{(product.trial || product.id === currentProduct) &&
              <small>{[product.trial && "试用中", product.id === currentProduct && "当前空间"].filter(Boolean).join(" · ")}</small>}</span>
          </LinkComponent>
        ) : (
          <span aria-disabled="true" className={styles.productSwitcherDisabled} key={product.id}>
            <span aria-hidden="true">{product.mark}</span>
            <span><b>{product.name}</b><small>{product.href ? "暂未开放" : "开发中"}</small></span>
          </span>
        );
      })}
    </ProductPopover>
  );
}

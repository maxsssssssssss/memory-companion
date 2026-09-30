"use client";

import Link from "next/link";
import { useEffect } from "react";

import { PRODUCT_CATALOG, type ProductId } from "./product-catalog";
import { ProductPopover } from "./product-popover";
import { rememberLastProduct } from "./product-preference";
import styles from "./product-system.module.css";
import { useProductCapabilities } from "./product-capabilities";

export function ProductSwitcher({
  accountId,
  currentProduct,
  dailyReflectionEnabled = true,
  workReviewEnabled
}: Readonly<{
  accountId: string;
  currentProduct: ProductId;
  dailyReflectionEnabled?: boolean;
  workReviewEnabled?: boolean;
}>) {
  const capabilities = useProductCapabilities();
  const workReviewAvailable = workReviewEnabled ?? capabilities.workReviewEnabled;
  useEffect(() => {
    rememberLastProduct(accountId, currentProduct);
  }, [accountId, currentProduct]);

  const current = PRODUCT_CATALOG.find((product) => product.id === currentProduct);
  return (
    <ProductPopover
      className={styles.productSwitcher}
      label={`切换产品，当前为${current?.name ?? "Daily Brief"}`}
      panelClassName={styles.productSwitcherMenu}
      trigger={(
        <>
          <span aria-hidden="true">DB</span>
          <b>{current?.name}</b>
          <i aria-hidden="true">⌄</i>
        </>
      )}
      triggerClassName={styles.productSwitcherTrigger}
    >
      <p>切换空间</p>
      <Link href="/">全部产品</Link>
      {PRODUCT_CATALOG.map((product) => {
        const enabled = product.id === "date_companion"
          || product.id === "learning_organizer"
          || (product.id === "daily_reflection" && dailyReflectionEnabled)
          || (product.id === "office_review" && workReviewAvailable);
        return product.href && enabled ? (
          <Link
            aria-current={product.id === currentProduct ? "page" : undefined}
            href={product.href}
            key={product.id}
            onClick={() => rememberLastProduct(accountId, product.id)}
          >
            <span aria-hidden="true">{product.mark}</span>
            <span><b>{product.name}</b><small>{product.trial ? "试用中 · " : ""}{product.id === currentProduct ? "当前空间" : "进入"}</small></span>
          </Link>
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

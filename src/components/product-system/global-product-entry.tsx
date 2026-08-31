"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { PRODUCT_CATALOG, type ProductId } from "./product-catalog";
import { ProductAccountMenu } from "./product-account-menu";
import { readLastProduct, rememberLastProduct } from "./product-preference";
import styles from "./product-system.module.css";

export function GlobalProductEntry({
  accountId,
  dailyReflectionEnabled,
  onLogout,
  userLabel
}: Readonly<{
  accountId: string;
  dailyReflectionEnabled: boolean;
  onLogout: () => Promise<void> | void;
  userLabel: string;
}>) {
  const [lastProduct, setLastProduct] = useState<Exclude<ProductId, "office_review"> | null>(null);

  useEffect(() => {
    setLastProduct(readLastProduct(accountId));
  }, [accountId]);

  return (
    <main className={styles.globalEntry}>
      <header className={styles.globalEntryHeader}>
        <Link aria-label="Daily Brief 产品入口" className={styles.globalWordmark} href="/">
          <span aria-hidden="true">DB</span>
          <b>Daily Brief</b>
        </Link>
        <ProductAccountMenu onLogout={onLogout} showLabel userLabel={userLabel} />
      </header>

      <section className={styles.globalEntryIntro}>
        <h1>选择一个空间</h1>
        <p>每个空间保留自己的内容边界，你可以随时回来切换。</p>
      </section>

      <section aria-label="产品空间" className={styles.globalProductGrid}>
        {PRODUCT_CATALOG.map((product) => {
          const enabled = product.id === "date_companion"
            || (product.id === "daily_reflection" && dailyReflectionEnabled);
          const wasLast = enabled && product.id === lastProduct;
          if (!product.href || !enabled) {
            return (
              <article aria-disabled="true" className={styles.globalProductUnavailable} key={product.id}>
                <div><span aria-hidden="true">{product.mark}</span><small>{product.href ? "暂未开放" : "开发中"}</small></div>
                <h2>{product.name}</h2>
                <p>{product.description}</p>
              </article>
            );
          }
          return (
            <Link
              className={styles.globalProductCard}
              data-product={product.id}
              href={product.href}
              key={product.id}
              onClick={() => rememberLastProduct(accountId, product.id as Exclude<ProductId, "office_review">)}
            >
              <div><span aria-hidden="true">{product.mark}</span>{wasLast ? <small>上次使用</small> : null}</div>
              <h2>{product.name}</h2>
              <p>{product.description}</p>
              <b>{wasLast ? "继续进入" : "进入"}<span aria-hidden="true">→</span></b>
            </Link>
          );
        })}
      </section>
    </main>
  );
}

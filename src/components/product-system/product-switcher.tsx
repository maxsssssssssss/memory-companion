"use client";

import Link from "next/link";
import { useEffect } from "react";

import type { ProductId } from "./product-catalog";
import { ProductSwitcherMenu } from "./product-switcher-menu";
import { rememberLastProduct } from "./product-preference";

import { useProductCapabilities } from "./product-capabilities";

export function ProductSwitcher({
  accountId,
  currentProduct,
  brandLabel,
  paperMotion,
  dailyReflectionEnabled = true,
  workReviewEnabled
}: Readonly<{
  accountId: string;
  currentProduct: ProductId;
  brandLabel?: string;
  paperMotion?: boolean;
  dailyReflectionEnabled?: boolean;
  workReviewEnabled?: boolean;
}>) {
  const capabilities = useProductCapabilities();
  const workReviewAvailable = workReviewEnabled ?? capabilities.workReviewEnabled;
  useEffect(() => {
    rememberLastProduct(accountId, currentProduct);
  }, [accountId, currentProduct]);

  return <ProductSwitcherMenu currentProduct={currentProduct} brandLabel={brandLabel} paperMotion={paperMotion}
    dailyReflectionEnabled={dailyReflectionEnabled} workReviewEnabled={workReviewAvailable}
    LinkComponent={Link} onChoose={id => rememberLastProduct(accountId, id)} />;
}

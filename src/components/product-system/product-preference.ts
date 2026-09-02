import { isProductId, type ProductId } from "./product-catalog";

export function productPreferenceKey(accountId: string) {
  return `daily-brief:${accountId}:last-product`;
}

export function readLastProduct(accountId: string, storage: Pick<Storage, "getItem"> = window.localStorage) {
  const value = storage.getItem(productPreferenceKey(accountId));
  return isProductId(value) ? value : null;
}

export function rememberLastProduct(
  accountId: string,
  productId: ProductId,
  storage: Pick<Storage, "setItem"> = window.localStorage
) {
  storage.setItem(productPreferenceKey(accountId), productId);
}

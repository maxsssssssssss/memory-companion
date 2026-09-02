"use client";

import { createContext, type ReactNode, useContext } from "react";

type ProductCapabilities = Readonly<{
  workReviewEnabled: boolean;
}>;

const ProductCapabilitiesContext = createContext<ProductCapabilities>({
  workReviewEnabled: false
});

export function ProductCapabilitiesProvider({
  children,
  workReviewEnabled
}: Readonly<ProductCapabilities & { children: ReactNode }>) {
  return (
    <ProductCapabilitiesContext.Provider value={{ workReviewEnabled }}>
      {children}
    </ProductCapabilitiesContext.Provider>
  );
}

export function useProductCapabilities() {
  return useContext(ProductCapabilitiesContext);
}

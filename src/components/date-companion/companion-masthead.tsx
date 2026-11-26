import type { ComponentType, ComponentPropsWithoutRef, ReactNode } from "react";
import chrome from "./book-home-chrome.module.css";
import styles from "./date-companion.module.css";

export type MastLinkProps = ComponentPropsWithoutRef<"a"> & { href: string };
export type MastTab = { label: string; href?: string; active: boolean };
type Props = {
  relationshipName: string;
  productMenu: ReactNode;
  accountMenu: ReactNode;
  tabs: MastTab[];
  LinkComponent: ComponentType<MastLinkProps> | "a";
  actions: ReactNode;
};

/** Identity and routing belong to the caller. The four book views share the
 * same navigation tree, grid and menu slots at every width. */
export function CompanionMasthead({
  relationshipName, productMenu, accountMenu, tabs, LinkComponent, actions
}: Props) {
  return <div className={`${styles.companionChrome} ${chrome.mast}`}>
    <div className={`${styles.topBar} ${chrome.bar}`}>
      {productMenu}
      <div className={`${styles.topBarTools} ${chrome.tools}`}>
        <span className={styles.topBarNote}>
          <span className={chrome.product}>约会陪伴</span><span data-current-relationship className={chrome.relationship}>{relationshipName}</span>
        </span>
        {accountMenu}
      </div>
    </div>
    <nav className={`${styles.nav} ${chrome.nav}`} aria-label="约会陪伴页面">
      <div className={styles.navLinks}>{tabs.map(tab => {
        const className=`${styles.navLink} ${tab.active ? styles.navLinkActive : ""}`;
        return tab.href
          ? <LinkComponent key={tab.label} className={className} href={tab.href} aria-current={tab.active ? "page" : undefined}>{tab.label}</LinkComponent>
          : <a key={tab.label} className={className} aria-disabled="true">{tab.label}</a>;
      })}</div>
      <div className={styles.navActions}>{actions}</div>
    </nav>
  </div>;
}

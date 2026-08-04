import { notFound } from "next/navigation";

import {
  CompanionPrototype,
  isPrototypeScreen,
  prototypeScreens
} from "../../_components/companion-prototypes";

type PrototypePageParams = {
  screen?: string[];
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [
    { screen: [] },
    ...prototypeScreens
      .filter((screen) => screen !== "home")
      .map((screen) => ({ screen: [screen] }))
  ];
}

export default async function DateCompanionPrototypePage({
  params
}: {
  params: Promise<PrototypePageParams>;
}) {
  const { screen } = await params;
  const selectedScreen = screen?.[0] ?? "home";

  if (!isPrototypeScreen(selectedScreen) || (screen?.length ?? 0) > 1) {
    notFound();
  }

  return <CompanionPrototype screen={selectedScreen} />;
}

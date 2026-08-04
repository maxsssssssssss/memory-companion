"use client";

import { useEffect, useState } from "react";

export type LocalTimeGreetingText = "早上好" | "上午好" | "中午好" | "下午好" | "晚上好";

export function getLocalTimeGreeting(hour: number): LocalTimeGreetingText {
  if (hour >= 5 && hour < 9) return "早上好";
  if (hour >= 9 && hour < 11) return "上午好";
  if (hour >= 11 && hour < 14) return "中午好";
  if (hour >= 14 && hour < 18) return "下午好";
  return "晚上好";
}

function readLocalTimeGreeting() {
  return getLocalTimeGreeting(new Date().getHours());
}

export function LocalTimeGreeting({ className }: { className?: string }) {
  const [greeting, setGreeting] = useState<LocalTimeGreetingText | "">("");

  useEffect(() => {
    const updateGreeting = () => setGreeting(readLocalTimeGreeting());
    updateGreeting();
    const timer = window.setInterval(updateGreeting, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <p className={className} data-local-time-greeting>
      {greeting}
    </p>
  );
}

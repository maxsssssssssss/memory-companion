import { redirect } from "next/navigation";

export default function ReflectionAskPage() {
  redirect("/reflection/think?mode=past_clues");
}

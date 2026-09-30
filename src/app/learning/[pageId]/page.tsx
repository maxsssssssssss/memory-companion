import { notFound } from "next/navigation";
import { LearningId } from "@/lib/domain/learning";
import { LearningWorkspace } from "@/components/learning/learning-workspace";

export default async function LearningPage({ params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  if (!LearningId.safeParse(pageId).success) notFound();
  return <LearningWorkspace key={pageId} pageId={pageId} />;
}

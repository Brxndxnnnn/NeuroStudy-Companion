"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SessionTopBar } from "@/components/TopNav";
import { Card, Button } from "@/components/ui";
import PostSessionSurvey from "@/components/PostSessionSurvey";

export default function QuestionnairePage() {
  const router = useRouter();
  const [surveyComplete, setSurveyComplete] = useState(false);

  return (
    <main className="min-h-screen bg-ground flex flex-col">
      <SessionTopBar onBack={() => router.push("/history")} backLabel="Dashboard" />
      <div className="flex-1 flex items-start justify-center px-5 py-10">
        <Card className="w-full max-w-3xl p-8 anim-rise">
          {surveyComplete ? (
            <div className="py-8 text-center">
              <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-good-soft text-good text-2xl">✓</div>
              <h2 className="text-xl font-bold text-ink">Survey submitted</h2>
              <p className="text-muted mt-2 mb-6">Thank you — your responses have been saved.</p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button onClick={() => router.push("/session/result")}>View session results →</Button>
                <Button variant="subtle" onClick={() => router.push("/history")}>Return to dashboard</Button>
              </div>
            </div>
          ) : (
            <PostSessionSurvey
              sessionId={typeof window !== "undefined" ? localStorage.getItem("currentSessionId") : null}
              onSubmitted={() => setSurveyComplete(true)}
            />
          )}
        </Card>
      </div>
    </main>
  );
}

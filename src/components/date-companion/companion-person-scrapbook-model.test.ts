import { describe, expect, it } from "vitest";
import { emptyDateCompanionViewModel, type DateCompanionMemoryBridgeState, type DateCompanionConfirmedPerson } from "@/lib/domain/date-companion";
import type { DateCompanionPersonArchive } from "@/lib/client/date-companion-people";
import { confirmedDirectory, currentScrapbookPerson, personScrapbookContent, scrapbookReaderKey } from "./companion-person-scrapbook-model";

const stamp = "2026-11-01T11:00:00.000Z";
function identified(id: string): DateCompanionConfirmedPerson {
  return { id, displayName: id, status: "confirmed", explicitlyConfirmed: true, version: 1, confirmedAt: stamp, createdAt: stamp, updatedAt: stamp };
}
function ready(): Extract<DateCompanionMemoryBridgeState, { status: "ready" }> {
  const mapping = { id: "pair", selfPersonId: "self", companionPersonId: "current", status: "confirmed" as const,
    relationshipType: "friend" as const, version: 1, confirmedAt: stamp, createdAt: stamp, updatedAt: stamp };
  const setting = { enabled: false, version: 1, enabledAt: null, disabledAt: stamp, createdAt: stamp, updatedAt: stamp };
  return {status:"ready", mapping, setting, people:["self","current","other"].map(identified),
    selfBinding:{ personId:"self", status:"active", version:1, setAt:stamp, clearedAt:null, updatedAt:stamp },
    review:{mapping, retention:setting, interactions:[]}, retainedSubjects:{}, memoryRetainedSourceKeys:[], relationshipPersonSources:[], personQaSources:[] };
}
function storedTimeline(id: string): DateCompanionPersonArchive {
  return {person:identified(id),entries:[{id:"memory",type:"event",status:"active",title:"散步",summary:"沿着河走了一段。",date:"2026-10-03",
    updatedAt:stamp,sourceStatement:"来自本人记录",sourceOrigin:"user_reflection",shared:false,
    sources:[{id:"ev",uploadId:"upload",sourceSegmentId:"line",quote:"沿着河走了一段。",date:"2026-10-03"}]}]};
}
describe("formal person scrapbook projection", () => {
  it("requires both confirmed people and an active matching self binding before treating the viewed person as current", () => {
    const state = ready();
    expect(confirmedDirectory(state).map(p=>p.id)).toEqual(["current","other"]);
    expect(currentScrapbookPerson(state)).toBe("current");
    expect(currentScrapbookPerson({...state, selfBinding:null})).toBeNull();
    expect(currentScrapbookPerson({...state, selfBinding:{...state.selfBinding!, personId:"other"}})).toBeNull();
    expect(currentScrapbookPerson({...state, people:state.people.filter(p=>p.id!=="current")})).toBeNull();
  });
  it("can browse another confirmed person without accessing a current or previously loaded person's material", () => {
    const state = ready();
    const vm = emptyDateCompanionViewModel();
    vm.relationship = {id:"relation", participantState:"confirmed", status:"active"};
    vm.recap.history = [{id:"upload", relationshipInteractionId:"meeting", sourceUploadId:"upload", uploadIds:["upload"],
      persistenceStatus:"confirmed", sourceState:"available", recordingDate:"2026-11-01", fileName:"随手记.m4a",
      title:"随手记", savedExcerpt:"只保存本次", status:"ready",transcript:[]}];
    const current = personScrapbookContent("current",state,{status:"idle"},vm,"relation");
    expect(current.meetings[0].savedExcerpt).toBe("只保存本次");
    expect(current.materials).toEqual([]);
    const another = personScrapbookContent("other",state,{status:"ready",archive:storedTimeline("other")},vm,"relation");
    expect(another.isCurrent).toBe(false);
    expect(another.meetings).toEqual([]);
    expect(another.materials.map(m=>m.id)).toEqual(["memory"]);
    const archiveMaterial = another.materials[0];
    const firstGrant = {...archiveMaterial,archiveSources:archiveMaterial.archiveSources!.map(s=>({...s,memoryEvidenceIds:["old-proof"]}))};
    const laterGrant = {...archiveMaterial,archiveSources:archiveMaterial.archiveSources!.map(s=>({...s,memoryEvidenceIds:["new-proof"]}))};
    expect(scrapbookReaderKey(firstGrant)).not.toBe(scrapbookReaderKey(laterGrant));
    expect(personScrapbookContent("other",state,{status:"ready",archive:storedTimeline("current")},vm,"relation").materials).toEqual([]);
    expect(personScrapbookContent("current",state,{status:"idle"},vm,"another-relation").meetings).toEqual([]);
  });
});

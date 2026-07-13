import { describe, expect, it } from "vitest";
import { audioFixtureDefinitions } from "./audio-fixtures.mjs";

describe("audio fixture definitions", () => {
  it("defines the three P0/P1 validation audio fixtures", () => {
    expect(audioFixtureDefinitions.map((fixture) => fixture.name)).toEqual([
      "non_relationship_60s",
      "relationship_dialogue_90s",
      "two_speaker_relationship"
    ]);
  });

  it("keeps relationship and non-relationship fixture intents explicit", () => {
    expect(audioFixtureDefinitions[0]).toMatchObject({
      expectedContext: "non_relationship",
      expectedRelationshipSignals: 0
    });
    expect(audioFixtureDefinitions[1]).toMatchObject({
      expectedContext: "relationship",
      expectedRelationshipSignals: "some"
    });
    expect(audioFixtureDefinitions[2]).toMatchObject({
      expectedContext: "relationship",
      expectedRelationshipSignals: "some"
    });
  });
});

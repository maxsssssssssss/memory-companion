import type { RelationshipSignalProvider } from "./provider";

export const emptyRelationshipSignalProvider: RelationshipSignalProvider = {
  async analyze() {
    return [];
  }
};

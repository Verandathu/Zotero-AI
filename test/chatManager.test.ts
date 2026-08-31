import { assert } from "chai";
import {
  ChatManager,
  normalizeConversationRecord,
} from "../src/modules/chatManager";

describe("chat manager", function () {
  it("migrates v1 messages without losing content", function () {
    const conversation = normalizeConversationRecord({
      id: "legacy",
      title: "Legacy",
      itemKey: "ABC",
      createdAt: 10,
      updatedAt: 20,
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
    });
    assert.equal(conversation?.messages.length, 2);
    assert.equal(conversation?.messages[0].id, "legacy-m0");
    assert.equal(conversation?.messages[1].content, "answer");
  });

  it("edits linearly and serializes only API fields", function () {
    const manager = new ChatManager();
    const conversation = manager.createConversation({
      libraryID: 1,
      key: "ABC",
      title: "Paper",
    });
    manager.appendMessages(conversation.id, [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" },
    ]);
    const firstID = conversation.messages[0].id;
    assert.isTrue(manager.editAndTruncate(conversation.id, firstID, "revised"));
    assert.deepEqual(manager.toAPIMessages(conversation.id), [
      { role: "user", content: "revised" },
    ]);
    manager.dispose();
  });

  it("supports reversible deletion", function () {
    const manager = new ChatManager();
    const conversation = manager.createConversation();
    assert.exists(manager.stageDeleteConversation(conversation.id, 60000));
    assert.lengthOf(manager.list, 0);
    assert.isTrue(manager.undoDeleteConversation(conversation.id));
    assert.equal(manager.active?.id, conversation.id);
    manager.dispose();
  });

  it("searches globally and filters by the current item", function () {
    const manager = new ChatManager();
    const paperA = manager.createConversation({ key: "A", title: "Alpha" });
    manager.renameConversation(paperA.id, "Methods review");
    const paperB = manager.createConversation({ key: "B", title: "Beta" });
    manager.renameConversation(paperB.id, "Results review");
    assert.deepEqual(
      manager.search("review", "A").map((item) => item.id),
      [paperA.id],
    );
    assert.deepEqual(
      manager.search("Beta", null).map((item) => item.id),
      [paperB.id],
    );
    manager.dispose();
  });

  it("reuses an empty conversation when rebinding to a paper", function () {
    const manager = new ChatManager();
    const conversation = manager.createConversation();
    assert.isTrue(
      manager.bindConversationToItem(conversation.id, {
        libraryID: 1,
        key: "CURRENT",
        title: "Current paper",
      }),
    );
    assert.equal(manager.list.length, 1);
    assert.equal(manager.active?.itemKey, "CURRENT");
    manager.appendMessages(conversation.id, [
      { role: "user", content: "question" },
    ]);
    assert.isFalse(
      manager.bindConversationToItem(conversation.id, {
        key: "OTHER",
        title: "Other paper",
      }),
    );
    manager.dispose();
  });
});

"""A small schemaVersion-3 backup exercising every store and the awkward cases:
threads via In-Reply-To and via References only, a system email, braces and
escapes in text, a tombstone, an unknown field that must round-trip."""
from __future__ import annotations

import json


def email(i: str, **kw) -> dict:
    rec = {
        "id": f"{i}@x", "messageId": f"{i}@x", "inReplyTo": "", "references": [],
        "subject": f"Subject {i}", "fromAddr": "a@corp.com", "fromName": "A",
        "toAddrs": ["me@work.example"], "ccAddrs": [], "date": "2026-05-01T09:00:00.000Z",
        "isSystemEmail": False, "status": "unread", "tags": [], "hasAttachments": False,
        "attachmentCount": 0, "importedAt": "2026-08-27T09:39:36.166Z", "fileName": f"{i}.eml",
    }
    rec.update(kw)
    return rec


def backup() -> dict:
    emails = [
        email("root", textBody="Hello {world}\n\n\n\nsecond \"quoted\" \\ line", tags=["action"],
              tagExclusions=["fyi"]),
        email("r1", inReplyTo="root@x", references=["root@x"], fromAddr="me@work.example",
              date="2026-05-02T09:00:00.000Z", textBody="Reply one"),
        # Outlook-style: no In-Reply-To, only References
        email("r2", references=["root@x", "r1@x"], date="2026-05-03T09:00:00.000Z",
              textBody="Reply two mentions Zürich"),
        email("sys", fromAddr="noreply@bentley.com", isSystemEmail=True, subject="[ProjectWise] }{",
              hasAttachments=True, attachmentCount=1, textBody="automated"),
        email("orphan", inReplyTo="missing@elsewhere", customField={"keep": [1, 2]}),
        email("gone", textBody="tombstoned before import"),
    ]
    return {
        "schemaVersion": 3,
        "exportedAt": "2026-09-03T02:31:43.221Z",
        "emails": emails,
        "attachments": [
            {"id": "sys@x::a.pdf", "emailId": "sys@x", "filename": "a.pdf", "contentType": "application/pdf",
             "size": 10, "hash": "h1", "isNested": False, "parentFilename": None,
             "importedAt": "2026-08-27T09:39:36.166Z", "extractedText": "pdf text",
             "extractionStatus": "done", "extractedAt": 1756000000000},
            {"id": "gone@x::b.txt", "emailId": "gone@x", "filename": "b.txt", "contentType": "text/plain",
             "size": 1, "hash": "h2", "isNested": False, "parentFilename": None, "importedAt": "x"},
        ],
        "tags": [{"name": "action", "color": "#f00"}],
        "msgIndex": [{"messageId": e["messageId"], "emailId": e["id"]} for e in emails],
        "smartViews": [{"id": "sv-1", "name": "Mine", "icon": "*", "groupOperator": "AND",
                        "groups": [{"operator": "AND", "rules": [
                            {"field": "fromDomain", "operator": "equals", "value": "corp.com"}]}],
                        "requiredTags": [], "excludeAutomated": True}],
        "settings": [{"key": "customAutomationPatterns", "senders": ["x"], "subjects": [], "body": []},
                     {"key": "emlArchiveDirHandle", "handle": {}}],
        "emailGroups": [{"id": "eg-1", "name": "Team", "members": ["a@corp.com"]}],
        "seenIds": [{"id": "gone@x"}],
        "addressBook": [{"email": "a@corp.com", "name": "A", "role": "PM", "jobScope": "MEP",
                         "projects": ["T5"], "notes": "", "updatedAt": 1}],
    }


def backup_text(**dumps_kw) -> str:
    return json.dumps(backup(), **dumps_kw)

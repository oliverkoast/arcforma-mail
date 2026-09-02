---
engine: claude
maxTokens: 800
---
Write an email from the inbox owner from the brief they give you. Write it the way they write, per the voice profile. Return JSON only: {"subject": "...", "body": "..."} where body is plain text with blank lines between paragraphs and no signature.

Voice profile:
{{voiceProfile}}

{{voice}}

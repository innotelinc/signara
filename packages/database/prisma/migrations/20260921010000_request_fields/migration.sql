-- Placed fields, from template to signer (#81).
--
-- Until now a template's placements were written and never read: `Document.templateId`
-- existed but nothing set it, and `fieldsForDocument` returned an empty list with its
-- own comment calling itself a placeholder. So a signer saw a PDF and a Sign button and
-- no placed field ever reached them or the evidence.
--
-- Two changes close that:
--
-- 1. A placement declares which signer fills it. OpenSign assigned every widget to a
--    signer; without that binding a placement on a multi-signer template is ambiguous
--    at signing time. Defaults to 0 (the first signer) — the only sensible reading of
--    the single-signer templates that exist today.
ALTER TABLE "TemplateField" ADD COLUMN "assigneeOrder" INTEGER NOT NULL DEFAULT 0;

-- 2. Placements are *copied* onto the request, bound to the concrete signer row, and
--    carry the value the signer supplied. A copy rather than a reference because
--    TemplatesService.update replaces a template's fields wholesale: editing a template
--    after a request has gone out must not rewrite what a live signer is being asked to
--    fill or what a signed request's evidence says they filled.
CREATE TABLE "RequestField" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "signerId" TEXT,
    "type" "FieldType" NOT NULL,
    "name" TEXT,
    "key" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "pageNumber" INTEGER NOT NULL DEFAULT 1,
    "x" INTEGER,
    "y" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "options" JSONB,
    "value" JSONB,
    "filledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestField_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RequestField_requestId_idx" ON "RequestField"("requestId");
CREATE INDEX "RequestField_signerId_idx" ON "RequestField"("signerId");

ALTER TABLE "RequestField" ADD CONSTRAINT "RequestField_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SigningRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A signer row is deleted only with its request, which cascades the fields too, so
-- SET NULL here would never fire in practice; it is the safe default for a value that
-- is evidence rather than configuration.
ALTER TABLE "RequestField" ADD CONSTRAINT "RequestField_signerId_fkey"
    FOREIGN KEY ("signerId") REFERENCES "Signer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

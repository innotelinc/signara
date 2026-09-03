-- A signer can complete a signing request only once. Keep the newest row
-- when repairing databases created before this constraint existed.
DELETE FROM "Signature"
WHERE ctid IN (
  SELECT duplicate_ctid
  FROM (
    SELECT ctid AS duplicate_ctid,
           row_number() OVER (
             PARTITION BY "requestId", "signerId"
             ORDER BY "signedAt" DESC, ctid DESC
           ) AS row_number
    FROM "Signature"
  ) duplicates
  WHERE row_number > 1
);

DROP INDEX IF EXISTS "Signature_signerId_key";
DROP INDEX IF EXISTS "Signature_signerId_idx";

CREATE UNIQUE INDEX "Signature_requestId_signerId_key"
  ON "Signature"("requestId", "signerId");

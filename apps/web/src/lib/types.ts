/**
 * Client-side API shapes. These mirror the NestJS DTOs / Prisma returns for
 * the screens the web app renders. Keep in sync with apps/api.
 */

export type DocumentStatus =
  | 'DRAFT'
  | 'AWAITING_SIGNATURE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'VOIDED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface DocumentVersion {
  id: string;
  version: number;
  fileKey: string;
  sizeBytes: string; // BigInt serializes as string
  checksumSha256: string;
  changeNote: string | null;
  createdAt: string;
  createdById: string | null;
}

export interface SigningRequestLite {
  id: string;
  status: DocumentStatus;
  mode: 'SEQUENTIAL' | 'PARALLEL';
  title: string | null;
  createdAt: string;
}

export interface DocumentDetail {
  id: string;
  title: string;
  description: string | null;
  fileName: string;
  fileKey: string;
  contentType: string | null;
  sizeBytes: string;
  checksumSha256: string;
  status: DocumentStatus;
  tags: string[];
  version: number;
  updatedAt: string;
  createdAt: string;
  /** The template whose placed fields this document carries, if any. */
  templateId: string | null;
  versions: DocumentVersion[];
  signingRequests: SigningRequestLite[];
}

export type FieldType =
  | 'SIGNATURE'
  | 'INITIAL'
  | 'DATE'
  | 'TEXT'
  | 'CHECKBOX'
  | 'DROPDOWN'
  | 'ATTACHMENT'
  | 'NAME'
  | 'EMAIL'
  | 'COMPANY'
  | 'JOB_TITLE'
  | 'PHONE'
  | 'ADDRESS'
  | 'CUSTOM';

export interface TemplateField {
  id?: string;
  type: FieldType;
  name: string | null;
  key: string | null;
  isRequired: boolean;
  pageNumber: number;
  /** Which signer fills this field, by order index (0 = first signer). */
  assigneeOrder: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  options?: unknown;
}

/**
 * A placed field on a live signing request, as the signer filling it sees it.
 * Copied from the template at send time, so it is what the signer was actually
 * asked, not what the template says today.
 */
export interface RequestField {
  id: string;
  type: FieldType;
  name: string | null;
  key: string | null;
  isRequired: boolean;
  pageNumber: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  options?: unknown;
  value?: unknown;
  filledAt?: string | null;
}

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  variables: Record<string, string> | null;
  updatedAt: string;
  fields: TemplateField[];
}

export type SignerRole = 'SIGNER' | 'APPROVER' | 'CC';

export interface SignerDraft {
  email: string;
  name?: string;
  role: SignerRole;
  orderIndex: number;
}

export interface CreatedSigningRequest {
  id: string;
  status: DocumentStatus;
  mode: 'SEQUENTIAL' | 'PARALLEL';
  title: string | null;
  message: string | null;
  deadline: string | null;
  document: { id: string; title: string; fileName: string };
  signers: Array<{
    id: string;
    email: string;
    name: string | null;
    role: SignerRole;
    status: string;
    orderIndex: number;
  }>;
}
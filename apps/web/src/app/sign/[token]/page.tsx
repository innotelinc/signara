import type { Metadata } from 'next';
import { SigningRoom } from './signing-room';

export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  return { title: 'Sign your document', robots: { index: false, follow: false } };
}

export default function SignPage({ params }: { params: { token: string } }) {
  return <SigningRoom token={params.token} />;
}
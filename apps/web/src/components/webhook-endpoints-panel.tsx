'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Plus, RefreshCw, RotateCw, Send, Trash2, Webhook } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, Spinner } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type HealthStatus = 'healthy' | 'failing' | 'disabled';

interface EndpointHealth {
  status: HealthStatus;
  failuresSinceSuccess: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  disabledReason: string | null;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  disabledAt: string | null;
  createdAt: string;
  health: EndpointHealth;
}

interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
}

interface CreatedEndpoint {
  id: string;
  secret: string;
}

const STATUS_TONE: Record<HealthStatus, 'green' | 'amber' | 'red'> = {
  healthy: 'green',
  failing: 'amber',
  disabled: 'red',
};

const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  failing: 'Failing',
  disabled: 'Disabled',
};

/** Colour + copy for the health strip under each endpoint. */
function healthDetail(health: EndpointHealth): { tone: string; text: string } {
  if (health.status === 'disabled') {
    return {
      tone: 'border-red-200 bg-red-50 text-red-700',
      text:
        health.disabledReason ??
        'This endpoint is disabled. Re-enable it once the subscriber is fixed.',
    };
  }
  if (health.status === 'failing') {
    const when = health.lastFailureAt
      ? new Date(health.lastFailureAt).toLocaleString()
      : 'recently';
    return {
      tone: 'border-amber-200 bg-amber-50 text-amber-800',
      text:
        `${health.failuresSinceSuccess} delivery attempt(s) failed since the last success` +
        `${health.lastError ? ` — last error: ${health.lastError}` : ''} (${when}).`,
    };
  }
  return {
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    text: health.lastSuccessAt
      ? `Last delivered ${new Date(health.lastSuccessAt).toLocaleString()}.`
      : 'No deliveries yet.',
  };
}

function eventsLabel(events: string[]): string {
  if (events.includes('*')) return 'All events';
  return events.join(', ');
}

export function WebhookEndpointsPanel() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [created, setCreated] = useState<CreatedEndpoint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const [list, log] = await Promise.all([
        api.get<WebhookEndpoint[]>('/api/v1/webhooks'),
        api.get<WebhookDelivery[]>('/api/v1/webhooks/deliveries'),
      ]);
      setEndpoints(list);
      setDeliveries(log);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to load webhook endpoints');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function enable(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await api.post(`/api/v1/webhooks/${id}/enable`);
      setNotice('Endpoint re-enabled. Its signing secret is unchanged.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to re-enable endpoint');
    } finally {
      setBusyId(null);
    }
  }

  async function ping(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await api.post(`/api/v1/webhooks/${id}/ping`);
      setNotice('Ping queued. Give the delivery log a moment to show the result.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send ping');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(endpoint: WebhookEndpoint) {
    if (!window.confirm(`Remove ${endpoint.url} and its delivery history?`)) return;
    setBusyId(endpoint.id);
    setNotice(null);
    try {
      await api.del(`/api/v1/webhooks/${endpoint.id}`);
      setNotice('Endpoint removed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove endpoint');
    } finally {
      setBusyId(null);
    }
  }

  async function create() {
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const endpoint = await api.post<CreatedEndpoint>('/api/v1/webhooks', {
        url: newUrl.trim(),
        description: newDescription.trim() || undefined,
      });
      setCreated(endpoint);
      setNewUrl('');
      setNewDescription('');
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to register endpoint');
    } finally {
      setCreating(false);
    }
  }

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <CircleAlert className="h-4 w-4 shrink-0" />
            You do not have permission to manage webhook endpoints. Ask an organization
            administrator for the <code className="font-mono">webhooks.manage</code> permission.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook endpoints</CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-4 w-4" />
            Add endpoint
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button className="font-medium underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {notice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {created && (
          <div className="rounded-lg border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-800">
            <p className="font-medium">Signing secret — shown once, copy it now.</p>
            <code className="mt-1 block overflow-x-auto font-mono text-xs break-all">
              {created.secret}
            </code>
            <button className="mt-2 font-medium underline" onClick={() => setCreated(null)}>
              I&apos;ve saved it
            </button>
          </div>
        )}

        {showForm && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-4">
            <div>
              <label className="label" htmlFor="webhook-url">
                Endpoint URL
              </label>
              <input
                id="webhook-url"
                className="input"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://hooks.example.com/signara"
              />
            </div>
            <div>
              <label className="label" htmlFor="webhook-description">
                Description
              </label>
              <input
                id="webhook-description"
                className="input"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What this subscriber does (optional)"
              />
            </div>
            <p className="text-xs text-slate-500">
              Subscribes to all events. Private and loopback URLs are rejected unless the deployment
              opts in.
            </p>
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={creating}
                disabled={newUrl.trim().length === 0}
                onClick={() => void create()}
              >
                <Plus className="h-4 w-4" />
                Register endpoint
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Spinner className="h-6 w-6 text-primary-500" />
          </div>
        ) : endpoints.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            <Webhook className="h-4 w-4 shrink-0" />
            No webhook endpoints yet. Register one to stream signing events to your systems.
          </div>
        ) : (
          <div className="space-y-3">
            {endpoints.map((endpoint) => {
              const detail = healthDetail(endpoint.health);
              const busy = busyId === endpoint.id;
              return (
                <div key={endpoint.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-ink-900">{endpoint.url}</span>
                        <Badge tone={STATUS_TONE[endpoint.health.status]}>
                          {STATUS_LABEL[endpoint.health.status]}
                        </Badge>
                      </div>
                      {endpoint.description && (
                        <p className="mt-1 text-sm text-slate-500">{endpoint.description}</p>
                      )}
                      <p className="mt-1 text-xs text-slate-400">
                        {eventsLabel(endpoint.events)} · registered{' '}
                        {new Date(endpoint.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {!endpoint.active && (
                        <Button size="sm" loading={busy} onClick={() => void enable(endpoint.id)}>
                          <RotateCw className="h-4 w-4" />
                          Re-enable
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!endpoint.active || busy}
                        onClick={() => void ping(endpoint.id)}
                      >
                        <Send className="h-4 w-4" />
                        Ping
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => void remove(endpoint)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                  </div>
                  <p className={cn('mt-3 rounded-md border px-3 py-2 text-xs', detail.tone)}>
                    {detail.text}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {deliveries.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold text-ink-900">Recent deliveries</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs tracking-wide text-slate-400 uppercase">
                    <th className="py-2 pr-4">When</th>
                    <th className="pr-4">Event</th>
                    <th className="pr-4">Status</th>
                    <th className="pr-4">Code</th>
                    <th className="pr-4">Attempts</th>
                    <th className="pr-4">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.slice(0, 25).map((delivery) => (
                    <tr key={delivery.id} className="border-t border-slate-100">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-500">
                        {new Date(delivery.lastAttemptAt ?? delivery.createdAt).toLocaleString()}
                      </td>
                      <td className="pr-4 whitespace-nowrap">{delivery.event}</td>
                      <td className="pr-4">
                        <Badge
                          tone={
                            delivery.status === 'DELIVERED'
                              ? 'green'
                              : delivery.status === 'FAILED'
                                ? 'red'
                                : 'gray'
                          }
                        >
                          {delivery.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="pr-4">{delivery.responseStatus ?? '—'}</td>
                      <td className="pr-4">{delivery.attempts}</td>
                      <td className="max-w-[16rem] truncate pr-4 text-slate-500">
                        {delivery.error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { Dashboard } from '../src/Dashboard';
import { PreferencesForm } from '../src/PreferencesForm';
import { bootstrapFixture, dinnerFixture } from './fixtures';
import './setup';

const props = { actorId: 'test-owner', busy: false, onHome: vi.fn(), onEdit: vi.fn(), onSettings: vi.fn(), onAction: vi.fn().mockResolvedValue(true), onCalendar: vi.fn() };
const interval = { start: '2026-11-10T19:00:00-06:00', end: '2026-11-10T22:00:00-06:00' };
const option = { index: 0, venueId: 'v', venueName: 'Test Bistro', address: 'Test address', start: interval.start, end: '2026-11-10T20:30:00-06:00', pricePerPerson: 40, currency: 'USD', reservationUrl: 'https://example.com', reservationState: 'unknown', ownChecks: { status: 'unresolved' as const, reasons: ['Opening hours need checking'] }, sources: [] };
describe('join and agreement flow', () => {
  it('joins with explicit availability-sharing consent before asking for answers', async () => {
    window.Telegram = { WebApp: { initData: 'TEST-ONLY', ready: vi.fn(), expand: vi.fn(), openLink: vi.fn(), openTelegramLink: vi.fn() } };
    window.history.replaceState({}, '', '/app/?invite=TEST-INVITE');
    const base = dinnerFixture(); const actions: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/bootstrap')) return new Response(JSON.stringify(bootstrapFixture({ invitation: { ...base.setup, formVersion: 'invite-form', dinnerId: base.id, partySize: 2, availablePlaces: 1, alreadyJoined: false, pending: false } })));
      if (url.includes('/actions')) { const action = JSON.parse(String(init?.body)); actions.push(action); return new Response(JSON.stringify({ ok: true, dinner: { ...base, role: 'member', own: { ...base.own, availabilitySharing: true } } })); }
      return new Response(JSON.stringify(base));
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join dinner' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Join dinner' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /join this dinner and share my manual availability/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Join dinner' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /What works.*for you/i })).toBeTruthy());
    expect(actions[0]).toMatchObject({ action: 'join', payload: { invite: 'TEST-INVITE', consent: true, shareAvailability: true } });
    expect(actions[0].payload.preferences).toBeUndefined();
    expect((screen.getByRole('checkbox', { name: /Share my manual availability with dinner members/ }) as HTMLInputElement).checked).toBe(true);
  });
  it('separates agreement from unresolved verification and permits explicit confirmation of unknown checks', () => {
    const dinner = dinnerFixture({ role: 'member', activeVersion: 1, options: [option], canConfirm: true, agreement: { version: 1, confirmed: 1, required: 2, agreed: false }, verification: { status: 'pending', checks: [{ kind: 'opening', status: 'pending', message: 'Opening hours still need checking' }] }, progress: { approved: 2, expected: 2, complete: 2, confirmed: 1 } } as any);
    const { rerender } = render(<Dashboard {...props} dinner={dinner} />);
    expect((screen.getByRole('button', { name: /This works for me/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'Group current choice' }).textContent).toContain('1 of 2');
    rerender(<Dashboard {...props} dinner={{ ...dinner, agreement: { version: 1, confirmed: 2, required: 2, agreed: true } } as any} />);
    expect(screen.getByText('Everyone agreed', { exact: true })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Plan verification' }).textContent).toContain('Opening hours still need checking');
    expect(screen.queryByText('Reservation confirmed', { exact: true })).toBeNull();
  });
  it('compares shared manual schedules while editing without showing private schedules or calendar busy times', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<PreferencesForm context={dinnerFixture().setup} actorId="test-owner" sharedAvailability={[{ userId: 'friend', name: 'Test Friend', status: 'shared', availability: [{ start: '2026-11-10T20:00:00-06:00', end: '2026-11-10T23:00:00-06:00' }] }, { userId: 'private', name: 'Private Friend', status: 'private', availability: [{ start: '2030-01-01T00:00:00Z', end: '2030-01-01T04:00:00Z' }] }]} initial={{ availability: [interval] }} foodConfirmed onBack={vi.fn()} onSave={save} busy={false} />);
    const comparison = screen.getByRole('region', { name: 'Shared availability' });
    expect(comparison.textContent).toContain('Test Friend'); expect(comparison.textContent).toContain('Private Friend'); expect(comparison.textContent).not.toContain('2030');
    expect(comparison.textContent).toMatch(/2 schedules visible to you/); expect(comparison.textContent).toMatch(/8:00 PM.*10:00 PM/);
    expect((screen.getByRole('checkbox', { name: /Share my manual availability with dinner members/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Save my answers/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({ shareAvailability: false, shareAnswers: false });
  });
});

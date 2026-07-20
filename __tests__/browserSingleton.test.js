/**
 * The shared Chromium must be launched exactly once, even under concurrent
 * callers — two live browsers inside the container memory cap is a real risk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock('puppeteer', () => ({ default: { launch: (...args) => launch(...args) } }));
vi.mock('@sparticuz/chromium', () => ({
  default: { executablePath: async () => null, args: [], headless: true },
}));
// No system Chromium in the test environment — skip the `which` probes.
vi.mock('child_process', () => ({
  execSync: () => { throw new Error('not found'); },
}));

const makeBrowser = () => ({ on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) });

describe('getOrLaunchBrowser', () => {
  beforeEach(() => {
    vi.resetModules(); // module-level singleton — reload between cases
    launch.mockReset();
  });

  it('launches once when two callers race for the browser', async () => {
    const browser = makeBrowser();
    launch.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(browser), 10)));
    const { getOrLaunchBrowser } = await import('../neptun/browser.js');

    const [first, second] = await Promise.all([getOrLaunchBrowser(), getOrLaunchBrowser()]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
  });

  it('does not cache a failed launch', async () => {
    const browser = makeBrowser();
    launch.mockRejectedValueOnce(new Error('launch boom')).mockResolvedValueOnce(browser);
    const { getOrLaunchBrowser } = await import('../neptun/browser.js');

    await expect(getOrLaunchBrowser()).rejects.toThrow('launch boom');
    await expect(getOrLaunchBrowser()).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closeBrowser shuts the instance down and allows a relaunch', async () => {
    const browser = makeBrowser();
    launch.mockResolvedValue(browser);
    const { getOrLaunchBrowser, closeBrowser } = await import('../neptun/browser.js');

    await getOrLaunchBrowser();
    await closeBrowser();
    expect(browser.close).toHaveBeenCalledTimes(1);

    await getOrLaunchBrowser();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closeBrowser is a no-op when nothing was launched', async () => {
    const { closeBrowser } = await import('../neptun/browser.js');

    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

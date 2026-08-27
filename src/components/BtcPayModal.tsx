import React, { useState, useEffect, useCallback } from 'react';
import { Bitcoin, Zap, CheckCircle2, Copy, Clock, ShieldCheck, ExternalLink, RefreshCw } from 'lucide-react';

export interface RealInvoice {
  invoiceId: string;
  btcpayInvoiceId: string;
  amountUsd: number;
  minutesAdded: number;
  checkoutLink: string;
  status: string;
  createdAt: number;
}

interface BtcPayModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  onAddMinutes: (minutes: number) => void;
}

export const BtcPayModal: React.FC<BtcPayModalProps> = ({ isOpen, onClose, userId, onAddMinutes }) => {
  const [selectedHours, setSelectedHours] = useState<number>(5);
  const [activeInvoice, setActiveInvoice] = useState<RealInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Poll the gateway for settlement status while an invoice is open.
  const pollSettlement = useCallback(async (invoiceId: string) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/me?userId=${userId}`);
        const data = await res.json();
        const inv = data.invoices?.find((x: any) => x.id === invoiceId);
        if (inv && inv.status === 'settled') {
          onAddMinutes(inv.minutes);
          setActiveInvoice(null);
          return;
        }
      } catch { /* keep polling */ }
    }
  }, [userId, onAddMinutes]);

  useEffect(() => {
    if (activeInvoice?.status === 'pending') {
      pollSettlement(activeInvoice.invoiceId);
    }
  }, [activeInvoice, pollSettlement]);

  if (!isOpen) return null;

  const handleGenerateInvoice = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/btcpay/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, usdAmount: selectedHours }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('Invoice failed:', data.error);
        return;
      }
      setActiveInvoice(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="w-full max-w-lg bg-zinc-950 border border-amber-500/40 rounded-2xl p-6 shadow-2xl relative font-sans">
        <button onClick={onClose} className="absolute top-4 right-4 text-zinc-400 hover:text-white transition-colors text-xl font-bold">&times;</button>

        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <Bitcoin className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-wide flex items-center gap-2">
              BTCPay Server Gateway <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30">Anonymous BTC</span>
            </h2>
            <p className="text-xs text-zinc-400">No KYC. $1 = 1 hour GPU time. Settlement credits your balance automatically.</p>
          </div>
        </div>

        {!activeInvoice ? (
          <div className="space-y-6">
            <div>
              <label className="block text-xs font-mono text-zinc-400 mb-2 uppercase tracking-wider">Select Runtime Hours ($1 USD / hour):</label>
              <div className="grid grid-cols-4 gap-3">
                {[1, 5, 12, 24].map((hrs) => (
                  <button
                    key={hrs}
                    type="button"
                    onClick={() => setSelectedHours(hrs)}
                    className={`p-3 rounded-xl border font-mono text-center transition-all ${
                      selectedHours === hrs
                        ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
                        : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    <div className="text-lg font-bold">${hrs}</div>
                    <div className="text-[10px] text-zinc-400">{hrs} Hours</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-zinc-900/70 p-4 rounded-xl border border-zinc-800 text-xs font-mono space-y-2">
              <div className="flex justify-between"><span className="text-zinc-400">Rate:</span><span className="text-emerald-400">$1.00 / hour</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">Credits:</span><span className="text-amber-300">{selectedHours * 60} minutes</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">GPU:</span><span className="text-amber-300">RTX 4080 SUPER / 4070 — isolated instance</span></div>
            </div>

            <button
              onClick={handleGenerateInvoice}
              disabled={loading}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold font-mono tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition-all"
            >
              {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
              GENERATE BTCPAY INVOICE (${selectedHours}.00)
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="p-4 bg-zinc-900/90 rounded-xl border border-amber-500/30 flex items-center justify-between font-mono">
              <div>
                <div className="text-[10px] text-zinc-400 uppercase">Total Due:</div>
                <div className="text-lg font-bold text-amber-400">${activeInvoice.amountUsd}.00 USD</div>
                <div className="text-xs text-zinc-400">Credits {activeInvoice.minutesAdded} minutes</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-zinc-400 uppercase">Status:</div>
                <div className="text-xs font-bold text-amber-400 flex items-center gap-1"><Clock className="w-3.5 h-3.5 animate-pulse" /> Awaiting payment</div>
              </div>
            </div>

            <div className="space-y-3 font-mono">
              <div className="text-xs text-zinc-400">Secure BTCPay Checkout:</div>
              <a
                href={activeInvoice.checkoutLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-sm tracking-wider shadow-lg shadow-amber-500/20 transition-all"
              >
                <ExternalLink className="w-4 h-4" /> OPEN BITCOIN CHECKOUT
              </a>
              <div className="flex items-center gap-2 bg-black p-2.5 rounded-lg border border-zinc-800 text-xs">
                <span className="flex-1 text-cyan-300 truncate">{activeInvoice.checkoutLink}</span>
                <button onClick={() => copyToClipboard(activeInvoice.checkoutLink)} className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded border border-amber-500/30 text-[11px] transition-colors">
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-800 flex items-center gap-2 text-xs text-zinc-400">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Payment is verified on-chain via the BTCPay webhook — your GPU balance is credited automatically once confirmed.
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

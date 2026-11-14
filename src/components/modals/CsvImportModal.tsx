import React, { useState } from 'react';
import Papa from 'papaparse';
import { Upload, AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type { StudentRecord } from '../../types/lasu';
import { Modal } from '../ui/Common';

interface ParsedRow {
  rowNumber: number;
  fullName: string;
  matricNumber: string;
  department: string;
  faculty: string;
  level: string;
  accountStatus: string;
  valid: boolean;
  issue?: string;
}

export function CsvImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<'upload' | 'preview' | 'result'>('upload');
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    importedCount: number;
    failedCount: number;
    succeeded: StudentRecord[];
    failed: Array<{ rowNumber: number; matricNumber: string; fullName: string; reason: string }>;
  } | null>(null);

  const reset = () => {
    setStep('upload');
    setFileName('');
    setParsedRows([]);
    setStructureError(null);
    setResult(null);
  };

  const downloadTemplate = () => {
    const csv = [
      'full_name,matric_number,department,faculty,level,account_status',
      'Oluwaseyi Adeyemi,240591001,MEC,Faculty of Engineering,200L,pending_activation',
      'Chisom Nwosu,240591002,ECE,Faculty of Engineering,200L,pending_activation',
      'Ibrahim Musa,240591003,CPE,Faculty of Engineering,200L,pending_activation',
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lasu-student-register-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFile = (file: File) => {
    setStructureError(null);
    setFileName(file.name);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = (results.meta.fields || []).map((f) => f.trim().toLowerCase());
        const required = ['full_name', 'matric_number', 'department', 'faculty', 'level', 'account_status'];
        const missing = required.filter((r) => !fields.includes(r));
        if (missing.length > 0) {
          setStructureError(`Missing required CSV columns: ${missing.join(', ')}`);
          return;
        }

        const seen = new Set<string>();
        const rows: ParsedRow[] = results.data.map((raw, idx) => {
          const norm: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) {
            norm[k.trim().toLowerCase()] = String(v ?? '').trim();
          }
          const fullName = norm.full_name || '';
          const matricNumber = (norm.matric_number || '').toUpperCase();
          const department = norm.department || '';
          const faculty = norm.faculty || '';
          const level = (norm.level || '').toUpperCase();
          const accountStatus = (norm.account_status || 'pending_activation').toLowerCase();

          let issue: string | undefined;
          if (!fullName || fullName.length < 2) issue = 'Missing full name';
          else if (!/^[A-Z0-9\-/]{5,24}$/.test(matricNumber)) issue = 'Invalid matriculation number';
          else if (seen.has(matricNumber)) issue = 'Duplicate matriculation number in file';
          else if (!department) issue = 'Missing department';
          else if (!['100L', '200L', '300L', '400L', '500L'].includes(level)) issue = 'Invalid level';

          if (matricNumber) seen.add(matricNumber);

          return {
            rowNumber: idx + 1,
            fullName,
            matricNumber,
            department,
            faculty,
            level,
            accountStatus,
            valid: !issue,
            issue,
          };
        });

        setParsedRows(rows);
        setStep('preview');
      },
      error: (err) => {
        setStructureError(`Could not parse CSV: ${err.message}`);
      },
    });
  };

  const confirmImport = async () => {
    setImporting(true);
    try {
      const res = await apiFetch<{
        importedCount: number;
        failedCount: number;
        succeeded: StudentRecord[];
        failed: Array<{ rowNumber: number; matricNumber: string; fullName: string; reason: string }>;
      }>('/api/students/import-csv', {
        method: 'POST',
        body: JSON.stringify({
          rows: parsedRows.map((r) => ({
            fullName: r.fullName,
            matricNumber: r.matricNumber,
            department: r.department,
            faculty: r.faculty,
            level: r.level,
            accountStatus: r.accountStatus,
          })),
        }),
      });
      setResult(res);
      setStep('result');
      onImported();
    } catch (err) {
      setStructureError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const validPreviewCount = parsedRows.filter((r) => r.valid).length;
  const invalidPreviewCount = parsedRows.length - validPreviewCount;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import Official Student Register (CSV)"
      subtitle="Validate structure, preview duplicates or invalid rows, and generate activation codes."
      maxWidth="max-w-3xl"
    >
      {step === 'upload' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-lg px-4 py-3">
            <div className="text-xs text-[#697586] dark:text-slate-400 break-words">
              Required columns: <span className="font-mono-tabular text-[#172337] dark:text-slate-200 break-all">full_name, matric_number, department, faculty, level, account_status</span>
            </div>
            <button
              type="button"
              onClick={downloadTemplate}
              className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0 self-start sm:self-auto"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Sample CSV</span>
            </button>
          </div>

          {structureError && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-4 py-3 text-xs text-[#D84A4A] dark:text-rose-400">
              {structureError}
            </div>
          )}

          <label className="block border-2 border-dashed border-[#E5EAF0] dark:border-slate-700 hover:border-[#4263EB] rounded-xl p-6 sm:p-10 text-center cursor-pointer transition-colors">
            <Upload className="w-8 h-8 text-[#4263EB] dark:text-blue-400 mx-auto mb-3" />
            <p className="text-sm font-semibold text-[#172337] dark:text-slate-100">Select a CSV file to upload</p>
            <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">All rows are validated before saving. Invalid rows are never silently discarded.</p>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </label>
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-3 min-w-0">
              <p className="text-xs text-[#697586] dark:text-slate-400 truncate">File ({fileName})</p>
              <p className="text-lg font-bold font-mono-tabular text-[#172337] dark:text-slate-100">{parsedRows.length} rows</p>
            </div>
            <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-3">
              <p className="text-xs text-[#16845B] dark:text-emerald-400">Valid Syntax</p>
              <p className="text-lg font-bold font-mono-tabular text-[#16845B] dark:text-emerald-400">{validPreviewCount}</p>
            </div>
            <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-3">
              <p className="text-xs text-[#D84A4A] dark:text-rose-400">Flagged Issues</p>
              <p className="text-lg font-bold font-mono-tabular text-[#D84A4A] dark:text-rose-400">{invalidPreviewCount}</p>
            </div>
          </div>

          <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-[#697586] dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Matric No.</th>
                  <th className="px-3 py-2 font-medium">Full Name</th>
                  <th className="px-3 py-2 font-medium">Dept</th>
                  <th className="px-3 py-2 font-medium">Level</th>
                  <th className="px-3 py-2 font-medium">Validation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                {parsedRows.slice(0, 50).map((r) => (
                  <tr key={r.rowNumber}>
                    <td className="px-3 py-2 font-mono-tabular text-[#697586] dark:text-slate-400">{r.rowNumber}</td>
                    <td className="px-3 py-2 font-mono-tabular font-medium text-[#172337] dark:text-slate-100">{r.matricNumber || '—'}</td>
                    <td className="px-3 py-2 text-[#172337] dark:text-slate-200">{r.fullName || '—'}</td>
                    <td className="px-3 py-2 text-[#697586] dark:text-slate-400">{r.department || '—'}</td>
                    <td className="px-3 py-2 font-mono-tabular text-[#697586] dark:text-slate-400">{r.level}</td>
                    <td className="px-3 py-2">
                      {r.valid ? (
                        <span className="text-[#16845B] dark:text-emerald-400 font-medium">Ready</span>
                      ) : (
                        <span className="text-[#D84A4A] dark:text-rose-400 font-medium">{r.issue}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 text-sm font-medium text-[#697586] dark:text-slate-300 border border-[#E5EAF0] dark:border-slate-700 rounded-lg"
            >
              Choose Another File
            </button>
            <button
              type="button"
              disabled={importing}
              onClick={confirmImport}
              className="px-5 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg disabled:opacity-60"
            >
              {importing ? 'Importing...' : 'Confirm Import'}
            </button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-4 flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-[#16845B] dark:text-emerald-400 shrink-0" />
              <div>
                <p className="text-xs text-[#697586] dark:text-slate-400">Imported Successfully</p>
                <p className="text-xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100">{result.importedCount}</p>
              </div>
            </div>
            <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-4 flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-[#D84A4A] dark:text-rose-400 shrink-0" />
              <div>
                <p className="text-xs text-[#697586] dark:text-slate-400">Rejected / Duplicate</p>
                <p className="text-xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100">{result.failedCount}</p>
              </div>
            </div>
          </div>

          {result.succeeded.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#172337] dark:text-slate-200 mb-2">Newly Imported Records & Activation Codes</h4>
              <div className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg max-h-44 overflow-y-auto divide-y divide-[#E5EAF0] dark:divide-slate-800 text-xs">
                {result.succeeded.map((s) => (
                  <div key={s.id} className="px-3 py-2 flex items-center justify-between">
                    <span className="text-[#172337] dark:text-slate-200">
                      <span className="font-mono-tabular font-medium text-[#172337] dark:text-white">{s.matricNumber}</span> · {s.fullName}
                    </span>
                    <span className="font-mono-tabular text-[#4263EB] dark:text-blue-400">{s.activationCode || 'Active'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.failed.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#D84A4A] dark:text-rose-400 mb-2">Failed Records (Preserved for Correction)</h4>
              <div className="border border-[#D84A4A]/25 rounded-lg max-h-44 overflow-y-auto divide-y divide-[#E5EAF0] dark:divide-slate-800 text-xs">
                {result.failed.map((f, idx) => (
                  <div key={idx} className="px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[#172337] dark:text-slate-200">
                      Row {f.rowNumber}: {f.matricNumber || 'No matric'} ({f.fullName || 'Unnamed'})
                    </span>
                    <span className="text-[#D84A4A] dark:text-rose-400">{f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
              className="px-5 py-2 text-sm font-medium text-white bg-[#14243A] dark:bg-[#4263EB] rounded-lg"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

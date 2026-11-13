import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type { AttendanceRecord, AttendanceSession, LateCountPolicy } from '../types/lasu.ts';
import { getLatePolicyDescription, getLateWeight } from './attendanceMath.ts';

export interface PdfReportRow {
  record: AttendanceRecord;
  session: AttendanceSession;
}

export interface PdfReportMetadata {
  institutionName: string;
  generatedBy: string;
  generatedAt: string;
  filters: {
    departmentLabel: string;
    courseLabel: string;
    dateRangeLabel: string;
    statusLabel: string;
    studentQuery: string;
  };
  lateCountPolicy: LateCountPolicy;
  summary: {
    totalRecords: number;
    presentCount: number;
    lateCount: number;
    absentCount: number;
    excusedCount: number;
    effectiveRate: number;
  };
}

export function streamAttendancePdfReport(
  res: Response,
  filename: string,
  meta: PdfReportMetadata,
  rows: PdfReportRow[]
) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 36,
    bufferPages: true,
    info: {
      Title: 'LASU Attend — Institutional Attendance Report',
      Author: 'LASU Attend',
      Subject: 'University Lecture Attendance Export',
    },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = doc.page.width - 72; // 841.89 - 72 = 769.89
  const left = 36;

  // Header Banner
  const drawReportHeader = (compact = false) => {
    doc.rect(left, 28, pageWidth, compact ? 38 : 54).fill('#14243A');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(compact ? 11 : 14);
    doc.text('LASU ATTEND — ATTENDANCE REPORT', left + 14, compact ? 41 : 38);
    doc.font('Helvetica').fontSize(8.5).fillColor('#B8C4D4');
    if (!compact) {
      doc.text(
        `${meta.institutionName}  |  Generated ${new Date(meta.generatedAt).toLocaleString()} by ${meta.generatedBy}`,
        left + 14,
        58
      );
    } else {
      doc.text(meta.filters.courseLabel, left + 14, 42, { align: 'right', width: pageWidth - 28 });
    }
  };

  drawReportHeader(false);

  // Filter Metadata & Totals Box
  let y = 94;
  doc.roundedRect(left, y, pageWidth, 66, 4).fillAndStroke('#F6F8FB', '#E5EAF0');

  doc.fillColor('#172337').font('Helvetica-Bold').fontSize(8.5);
  doc.text('Applied Filters', left + 12, y + 10);
  doc.text('Summary Totals', left + 400, y + 10);

  doc.font('Helvetica').fontSize(8).fillColor('#697586');
  doc.text(
    `Department: ${meta.filters.departmentLabel}   |   Course: ${meta.filters.courseLabel}`,
    left + 12,
    y + 24,
    { width: 370 }
  );
  doc.text(
    `Date Range: ${meta.filters.dateRangeLabel}   |   Status: ${meta.filters.statusLabel}${meta.filters.studentQuery ? `   |   Student: ${meta.filters.studentQuery}` : ''}`,
    left + 12,
    y + 37,
    { width: 370 }
  );
  doc.text(`Policy: ${getLatePolicyDescription(meta.lateCountPolicy)}`, left + 12, y + 50, { width: 370 });

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#172337');
  doc.text(
    `Total Records: ${meta.summary.totalRecords.toLocaleString()}     Effective Rate: ${meta.summary.effectiveRate}%`,
    left + 400,
    y + 25
  );
  doc.font('Helvetica').fontSize(8.5);
  doc.fillColor('#16845B').text(`Present: ${meta.summary.presentCount.toLocaleString()}`, left + 400, y + 42);
  doc.fillColor('#D99020').text(`Late: ${meta.summary.lateCount.toLocaleString()}`, left + 485, y + 42);
  doc.fillColor('#D84A4A').text(`Absent: ${meta.summary.absentCount.toLocaleString()}`, left + 560, y + 42);
  doc.fillColor('#697586').text(`Excused: ${meta.summary.excusedCount.toLocaleString()}`, left + 645, y + 42);

  y = 172;

  const cols = [
    { label: 'Matric No.', width: 78 },
    { label: 'Student Name', width: 145 },
    { label: 'Course', width: 66 },
    { label: 'Date', width: 68 },
    { label: 'Status', width: 58 },
    { label: 'Check-In', width: 68 },
    { label: '2nd Check', width: 68 },
    { label: 'Correction / Notes', width: pageWidth - (78 + 145 + 66 + 68 + 58 + 68 + 68) },
  ];

  const drawTableHeader = (topY: number) => {
    doc.rect(left, topY, pageWidth, 22).fill('#0D1828');
    let cx = left + 6;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
    for (const col of cols) {
      doc.text(col.label, cx, topY + 7, { width: col.width - 8, ellipsis: true, lineBreak: false });
      cx += col.width;
    }
    return topY + 22;
  };

  y = drawTableHeader(y);
  const bottomLimit = doc.page.height - 46;

  if (rows.length === 0) {
    doc.rect(left, y, pageWidth, 34).fillAndStroke('#FFFFFF', '#E5EAF0');
    doc.font('Helvetica').fontSize(9).fillColor('#697586');
    doc.text('No attendance records matched the selected report filters.', left + 12, y + 12);
  } else {
    rows.forEach((item, index) => {
      const rowHeight = 20;
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        drawReportHeader(true);
        y = drawTableHeader(76);
      }

      const bg = index % 2 === 0 ? '#FFFFFF' : '#F6F8FB';
      doc.rect(left, y, pageWidth, rowHeight).fill(bg);
      doc.moveTo(left, y + rowHeight).lineTo(left + pageWidth, y + rowHeight).strokeColor('#E5EAF0').lineWidth(0.5).stroke();

      const { record, session } = item;
      const checkInStr = record.checkInTime
        ? new Date(record.checkInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—';
      const checkpointLabel =
        record.checkpointStatus === 'completed'
          ? 'Verified'
          : record.checkpointStatus === 'missed'
            ? 'Missed'
            : '—';

      const values = [
        record.matricNumber,
        record.studentName,
        session.courseCode,
        session.sessionDate,
        record.status.toUpperCase(),
        checkInStr,
        checkpointLabel,
        record.correctionReason || '—',
      ];

      let cx = left + 6;
      doc.font('Helvetica').fontSize(7.8);
      values.forEach((val, colIdx) => {
        if (colIdx === 4) {
          if (record.status === 'present') doc.fillColor('#16845B');
          else if (record.status === 'late') doc.fillColor('#D99020');
          else if (record.status === 'absent') doc.fillColor('#D84A4A');
          else doc.fillColor('#697586');
          doc.font('Helvetica-Bold');
        } else {
          doc.fillColor('#172337');
          doc.font(colIdx === 0 ? 'Helvetica-Bold' : 'Helvetica');
        }
        doc.text(val, cx, y + 6, { width: cols[colIdx].width - 8, ellipsis: true, lineBreak: false });
        cx += cols[colIdx].width;
      });

      y += rowHeight;
    });
  }

  // Add consistent Page X of Y footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7.5).fillColor('#697586');
    doc.text(
      `LASU Attend Institutional Export  ·  Confidential Academic Record`,
      left,
      doc.page.height - 28,
      { align: 'left', width: pageWidth / 2 }
    );
    doc.text(
      `Page ${i + 1} of ${range.count}`,
      left + pageWidth / 2,
      doc.page.height - 28,
      { align: 'right', width: pageWidth / 2 }
    );
  }

  doc.end();
}

export function computeExportSummary(rows: PdfReportRow[], policy: LateCountPolicy) {
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let excusedCount = 0;
  for (const { record } of rows) {
    if (record.status === 'present') presentCount++;
    else if (record.status === 'late') lateCount++;
    else if (record.status === 'absent') absentCount++;
    else if (record.status === 'excused') excusedCount++;
  }
  const eligible = Math.max(0, rows.length - excusedCount);
  const effective = presentCount + lateCount * getLateWeight(policy);
  const effectiveRate = eligible > 0 ? Math.round((effective / eligible) * 1000) / 10 : 0;
  return {
    totalRecords: rows.length,
    presentCount,
    lateCount,
    absentCount,
    excusedCount,
    effectiveRate,
  };
}

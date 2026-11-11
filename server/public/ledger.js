/**
 * ============================================================================
 * UniServ Co-op Treasury Ledger Frontend Client (Phase 6.1)
 * ============================================================================
 * Self-contained, dependency-free client for live cooperative transparency.
 *
 * CRITICAL SECURITY INVARIANT:
 * All store-derived text is rendered strictly using textContent (never innerHTML)
 * to completely eliminate XSS vulnerabilities from user-supplied strings or
 * extra-work descriptions.
 * ============================================================================
 */

(function () {
  'use strict';

  // State
  let rawRecords = [];
  let currentSummary = null;
  let sortDescending = true;
  let expandedBookingIds = new Set();

  // DOM Elements
  const kpiTotalBookings = document.getElementById('kpiTotalBookings');
  const kpiSettledCount = document.getElementById('kpiSettledCount');
  const kpiTotalAuthorized = document.getElementById('kpiTotalAuthorized');
  const kpiTotalCaptured = document.getElementById('kpiTotalCaptured');
  const kpiArtisanPaid = document.getElementById('kpiArtisanPaid');
  const kpiWelfarePaid = document.getElementById('kpiWelfarePaid');
  const kpiReservePaid = document.getElementById('kpiReservePaid');
  const kpiPlatformRetained = document.getElementById('kpiPlatformRetained');
  const kpiPendingPayouts = document.getElementById('kpiPendingPayouts');
  const kpiUnclaimedSub = document.getElementById('kpiUnclaimedSub');

  const asOfTimeEl = document.getElementById('asOfTime');
  const connPill = document.getElementById('connPill');
  const connStatusText = document.getElementById('connStatusText');
  const refreshBtn = document.getElementById('refreshBtn');

  const searchInput = document.getElementById('searchInput');
  const decisionFilter = document.getElementById('decisionFilter');
  const serviceFilter = document.getElementById('serviceFilter');
  const sortToggleBtn = document.getElementById('sortToggleBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  const tableBody = document.getElementById('tableBody');
  const emptyState = document.getElementById('emptyState');

  /**
   * Helper: creates an element with optional text and className via safe textContent.
   * @param {string} tag
   * @param {string|number} text
   * @param {string} className
   * @returns {HTMLElement}
   */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  /**
   * Updates live server status badge.
   * @param {boolean} online
   */
  function updateConnectionStatus(online) {
    if (online) {
      connPill.className = 'status-pill status-live';
      connStatusText.textContent = 'Connected (Sandbox)';
    } else {
      connPill.className = 'status-pill status-offline';
      connStatusText.textContent = 'Disconnected';
    }
  }

  /**
   * Fetches summary data and updates KPI cards.
   */
  async function fetchSummary() {
    try {
      const res = await fetch('/api/ledger/summary');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      currentSummary = data;

      // Update KPI cards with safe textContent
      kpiTotalBookings.textContent = String(data.total_bookings || 0);
      const settledCount = data.counts_by_decision?.SETTLED || 0;
      kpiSettledCount.textContent = settledCount + ' Settled';

      kpiTotalAuthorized.textContent = '$' + (data.total_authorized_usd || '0.00');
      kpiTotalCaptured.textContent = '$' + (data.total_captured_usd || '0.00');
      kpiArtisanPaid.textContent = '$' + (data.total_artisan_wages_paid_usd || '0.00');
      kpiWelfarePaid.textContent = '$' + (data.total_welfare_paid_usd || '0.00');
      kpiReservePaid.textContent = '$' + (data.total_reserve_paid_usd || '0.00');
      kpiPlatformRetained.textContent = '$' + (data.total_platform_retained_usd || '0.00');

      kpiPendingPayouts.textContent = '$' + (data.total_payouts_pending_usd || '0.00');
      kpiUnclaimedSub.textContent = '$' + (data.total_payouts_unclaimed_usd || '0.00') + ' unclaimed';

      if (data.as_of) {
        const d = new Date(data.as_of);
        asOfTimeEl.textContent = 'Data as of: ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      updateConnectionStatus(true);
    } catch (err) {
      console.error('Error fetching summary:', err);
      updateConnectionStatus(false);
    }
  }

  /**
   * Fetches booking records and updates table.
   */
  async function fetchRecords() {
    try {
      const res = await fetch('/api/ledger/records');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      rawRecords = Array.isArray(data.records) ? data.records : [];

      populateServiceFilter(rawRecords);
      renderTable();
      updateConnectionStatus(true);
    } catch (err) {
      console.error('Error fetching records:', err);
      updateConnectionStatus(false);
    }
  }

  /**
   * Populates the service filter dropdown with distinct service names.
   * @param {Array} records
   */
  function populateServiceFilter(records) {
    const currentVal = serviceFilter.value;
    const services = new Set();
    records.forEach(r => {
      if (r.service_name && r.service_name !== 'n/a') {
        services.add(r.service_name);
      }
    });

    // Clear and rebuild options
    while (serviceFilter.firstChild) {
      serviceFilter.removeChild(serviceFilter.firstChild);
    }

    const allOpt = el('option', 'All Services');
    allOpt.value = 'ALL';
    serviceFilter.appendChild(allOpt);

    Array.from(services).sort().forEach(svc => {
      const opt = el('option', svc);
      opt.value = svc;
      serviceFilter.appendChild(opt);
    });

    serviceFilter.value = currentVal || 'ALL';
  }

  /**
   * Filters and sorts the raw records based on UI controls.
   * @returns {Array} Filtered records
   */
  function getFilteredRecords() {
    const query = (searchInput.value || '').trim().toLowerCase();
    const decisionVal = decisionFilter.value;
    const serviceVal = serviceFilter.value;

    return rawRecords.filter(r => {
      // Decision filter
      if (decisionVal !== 'ALL' && r.decision !== decisionVal) {
        return false;
      }
      // Service filter
      if (serviceVal !== 'ALL' && r.service_name !== serviceVal) {
        return false;
      }
      // Text search query
      if (query) {
        const bId = (r.booking_id || '').toLowerCase();
        const svName = (r.service_name || '').toLowerCase();
        const pStatus = (r.paypal_status || '').toLowerCase();
        const dec = (r.decision || '').toLowerCase();
        const pyr = (r.payer || '').toLowerCase();

        if (
          !bId.includes(query) &&
          !svName.includes(query) &&
          !pStatus.includes(query) &&
          !dec.includes(query) &&
          !pyr.includes(query)
        ) {
          return false;
        }
      }
      return true;
    }).sort((a, b) => {
      const timeA = new Date(a.created_at).getTime() || 0;
      const timeB = new Date(b.created_at).getTime() || 0;
      return sortDescending ? timeB - timeA : timeA - timeB;
    });
  }

  /**
   * Renders the table body strictly with DOM nodes and textContent.
   */
  function renderTable() {
    const filtered = getFilteredRecords();

    // Clear existing rows safely
    while (tableBody.firstChild) {
      tableBody.removeChild(tableBody.firstChild);
    }

    if (filtered.length === 0) {
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    filtered.forEach(record => {
      const isExpanded = expandedBookingIds.has(record.booking_id);

      // Main Row
      const tr = el('tr', null, 'row-item' + (isExpanded ? ' expanded' : ''));
      tr.addEventListener('click', () => toggleRowExpand(record.booking_id));

      // Expand Icon
      const tdExpand = el('td', null, null);
      const btnExpand = el('button', '▶', 'expand-btn');
      btnExpand.setAttribute('aria-label', 'Toggle details for booking ' + record.booking_id);
      tdExpand.appendChild(btnExpand);
      tr.appendChild(tdExpand);

      // Booking ID (Last 8)
      const tdId = el('td', null, null);
      const codeSpan = el('span', record.booking_id, 'booking-code');
      tdId.appendChild(codeSpan);
      tr.appendChild(tdId);

      // Created At
      const createdStr = record.created_at !== 'n/a'
        ? new Date(record.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'n/a';
      tr.appendChild(el('td', createdStr));

      // Service
      tr.appendChild(el('td', record.service_name));

      // Payer
      tr.appendChild(el('td', record.payer));

      // Data Mode
      const tdDataMode = el('td', null, null);
      tdDataMode.appendChild(el('span', record.data_mode, 'badge-mode'));
      tr.appendChild(tdDataMode);

      // Agent Mode
      const tdAgentMode = el('td', null, null);
      tdAgentMode.appendChild(el('span', record.agent_mode, 'badge-agent'));
      tr.appendChild(tdAgentMode);

      // Decision
      const tdDecision = el('td', null, null);
      let badgeClass = 'badge-na';
      if (record.decision === 'SETTLED') badgeClass = 'badge-settled';
      else if (record.decision === 'HELD') badgeClass = 'badge-held';
      else if (record.decision === 'PENDING') badgeClass = 'badge-pending';
      else if (record.decision === 'FAILED') badgeClass = 'badge-failed';
      tdDecision.appendChild(el('span', record.decision, 'badge ' + badgeClass));
      tr.appendChild(tdDecision);

      // PayPal Status
      tr.appendChild(el('td', record.paypal_status));

      // Financial columns (num-col)
      tr.appendChild(el('td', '$' + record.authorized_usd, 'num-col'));
      tr.appendChild(el('td', '$' + record.captured_usd, 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.artisan_wages_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.welfare_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.reserve_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.platform_retained_usd || '0.00'), 'num-col'));

      // PayPal Fee
      const feeStr = record.breakdown?.paypal_fee_usd !== 'n/a' ? '$' + record.breakdown.paypal_fee_usd : 'n/a';
      tr.appendChild(el('td', feeStr, 'num-col'));

      // Policy Flags
      const tdFlags = el('td', null, null);
      if (Array.isArray(record.policy_flags) && record.policy_flags.length > 0) {
        tdFlags.appendChild(el('span', record.policy_flags.join(', '), 'flags-pill'));
      } else if (Array.isArray(record.policy_flags) && record.policy_flags.length === 0) {
        tdFlags.appendChild(el('span', 'None', 'badge-na'));
      } else {
        tdFlags.appendChild(el('span', 'n/a', 'badge-na'));
      }
      tr.appendChild(tdFlags);

      tableBody.appendChild(tr);

      // If Expanded, append detail row
      if (isExpanded) {
        tableBody.appendChild(buildDetailRow(record));
      }
    });
  }

  /**
   * Builds the expandable detail row for a record.
   * Rendered strictly with textContent for complete XSS safety.
   * @param {object} record
   * @returns {HTMLElement}
   */
  function buildDetailRow(record) {
    const tr = el('tr', null, 'detail-row');
    const td = el('td', null, null);
    td.colSpan = 17;

    const container = el('div', null, 'detail-container');
    const grid = el('div', null, 'detail-grid');

    // Card 1: PayPal Transaction Identifiers
    const idCard = el('div', null, 'detail-card');
    idCard.appendChild(el('div', 'PayPal Identifiers', 'detail-card-title'));

    const itemCap = el('div', null, 'detail-item');
    itemCap.appendChild(el('span', 'Capture ID (Last 4)', 'detail-key'));
    itemCap.appendChild(el('span', record.capture_id ? '...' + record.capture_id : 'None', 'detail-val'));
    idCard.appendChild(itemCap);

    const itemBatch = el('div', null, 'detail-item');
    itemBatch.appendChild(el('span', 'Payout Batch (Last 4)', 'detail-key'));
    itemBatch.appendChild(el('span', record.payout_batch_id ? '...' + record.payout_batch_id : 'None', 'detail-val'));
    idCard.appendChild(itemBatch);

    const itemPayer = el('div', null, 'detail-item');
    itemPayer.appendChild(el('span', 'Payer Information', 'detail-key'));
    itemPayer.appendChild(el('span', record.payer, 'detail-val'));
    idCard.appendChild(itemPayer);

    grid.appendChild(idCard);

    // Card 2: Service & Execution Metrics
    const metricsCard = el('div', null, 'detail-card');
    metricsCard.appendChild(el('div', 'Service & Timing', 'detail-card-title'));

    const itemType = el('div', null, 'detail-item');
    itemType.appendChild(el('span', 'Booking Type', 'detail-key'));
    itemType.appendChild(el('span', record.booking_type, 'detail-val'));
    metricsCard.appendChild(itemType);

    const itemSec = el('div', null, 'detail-item');
    itemSec.appendChild(el('span', 'Active Service Duration', 'detail-key'));
    const secVal = record.active_seconds !== 'n/a' ? record.active_seconds + ' s' : 'n/a';
    itemSec.appendChild(el('span', secVal, 'detail-val'));
    metricsCard.appendChild(itemSec);

    const itemFee = el('div', null, 'detail-item');
    itemFee.appendChild(el('span', 'PayPal Fee (Recorded)', 'detail-key'));
    itemFee.appendChild(el('span', record.breakdown?.paypal_fee_usd !== 'n/a' ? '$' + record.breakdown.paypal_fee_usd : 'n/a', 'detail-val'));
    metricsCard.appendChild(itemFee);

    grid.appendChild(metricsCard);

    // Card 3: Extra Work Details (Safely rendered via textContent)
    const extraCard = el('div', null, 'detail-card');
    extraCard.appendChild(el('div', 'Extra Work Notes', 'detail-card-title'));

    const itemExtra = el('div', null, 'detail-item');
    itemExtra.appendChild(el('span', 'Description', 'detail-key'));
    // CRITICAL: extra_work_description rendered strictly as textContent
    const extraVal = el('span', record.extra_work_description, 'detail-val');
    extraVal.style.whiteSpace = 'normal';
    itemExtra.appendChild(extraVal);
    extraCard.appendChild(itemExtra);

    grid.appendChild(extraCard);
    container.appendChild(grid);

    // Agent Trace Timeline
    if (Array.isArray(record.trace) && record.trace.length > 0) {
      const traceCard = el('div', null, 'trace-card');
      traceCard.appendChild(el('div', 'Settlement Agent Audit Trace (' + record.trace.length + ' steps)', 'trace-title'));

      const list = el('ul', null, 'trace-list');
      record.trace.forEach(step => {
        const item = el('li', null, 'trace-item');
        const header = el('div', null, null);

        header.appendChild(el('span', 'Step ' + (step.step || '-') + ': ' + (step.type || 'action'), 'trace-step-type'));
        if (step.timestamp) {
          const t = new Date(step.timestamp).toLocaleTimeString();
          header.appendChild(el('span', t, 'trace-step-time'));
        }
        item.appendChild(header);

        // Render summary details if available
        const detailsObj = {};
        if (step.decision) detailsObj.decision = step.decision;
        if (step.reason) detailsObj.reason = step.reason;
        if (step.note) detailsObj.note = step.note;
        if (step.amount_usd_cents) detailsObj.amount_usd = '$' + (step.amount_usd_cents / 100).toFixed(2);
        if (step.status) detailsObj.status = step.status;
        if (step.high_flags && step.high_flags.length) detailsObj.high_flags = step.high_flags;
        if (step.low_flags && step.low_flags.length) detailsObj.low_flags = step.low_flags;

        if (Object.keys(detailsObj).length > 0) {
          const detailText = Object.entries(detailsObj)
            .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
            .join(' | ');
          item.appendChild(el('div', detailText, 'trace-step-details'));
        }

        list.appendChild(item);
      });
      traceCard.appendChild(list);
      container.appendChild(traceCard);
    }

    td.appendChild(container);
    tr.appendChild(td);
    return tr;
  }

  /**
   * Toggles the row expansion state for a booking ID.
   * @param {string} bookingId
   */
  function toggleRowExpand(bookingId) {
    if (expandedBookingIds.has(bookingId)) {
      expandedBookingIds.delete(bookingId);
    } else {
      expandedBookingIds.add(bookingId);
    }
    renderTable();
  }

  /**
   * Generates and downloads RFC 4180 compliant CSV of filtered rows.
   */
  function downloadCsv() {
    const filtered = getFilteredRecords();
    if (filtered.length === 0) {
      alert('No records available to export.');
      return;
    }

    const headers = [
      'Booking ID',
      'Created At',
      'Service',
      'Booking Type',
      'Payer',
      'Data Mode',
      'Agent Mode',
      'Decision',
      'PayPal Status',
      'Authorized USD',
      'Captured USD',
      'Artisan Wages USD',
      'Welfare USD',
      'Reserve USD',
      'Platform Retained USD',
      'PayPal Fee USD',
      'Active Seconds',
      'Policy Flags',
      'Capture ID (Last 4)',
      'Payout Batch ID (Last 4)'
    ];

    function escapeCsvCell(val) {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
      } else {
        str = '"' + str + '"';
      }
      return str;
    }

    const rows = [headers.map(escapeCsvCell).join(',')];

    filtered.forEach(r => {
      const flagsStr = Array.isArray(r.policy_flags) ? r.policy_flags.join('; ') : r.policy_flags;
      const row = [
        r.booking_id,
        r.created_at,
        r.service_name,
        r.booking_type,
        r.payer,
        r.data_mode,
        r.agent_mode,
        r.decision,
        r.paypal_status,
        r.authorized_usd,
        r.captured_usd,
        r.breakdown?.artisan_wages_usd || '0.00',
        r.breakdown?.welfare_usd || '0.00',
        r.breakdown?.reserve_usd || '0.00',
        r.breakdown?.platform_retained_usd || '0.00',
        r.breakdown?.paypal_fee_usd || 'n/a',
        r.active_seconds,
        flagsStr,
        r.capture_id || '',
        r.payout_batch_id || ''
      ];
      rows.push(row.map(escapeCsvCell).join(','));
    });

    const csvContent = rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', 'uniserv-coop-ledger-' + dateStr + '.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Event Listeners
  searchInput.addEventListener('input', renderTable);
  decisionFilter.addEventListener('change', renderTable);
  serviceFilter.addEventListener('change', renderTable);

  sortToggleBtn.addEventListener('click', () => {
    sortDescending = !sortDescending;
    sortToggleBtn.textContent = sortDescending ? 'Sort: Newest First' : 'Sort: Oldest First';
    renderTable();
  });

  downloadCsvBtn.addEventListener('click', downloadCsv);

  refreshBtn.addEventListener('click', () => {
    fetchSummary();
    fetchRecords();
  });

  // Initial Data Fetch
  fetchSummary();
  fetchRecords();
})();

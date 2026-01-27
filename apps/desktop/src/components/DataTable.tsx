import React, { useState, useMemo } from 'react';
import './DataTable.css';

export type SortDirection = 'asc' | 'desc' | null;

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (item: T) => React.ReactNode;
  sortValue?: (item: T) => string | number | null | undefined; // Extract sortable value (should match displayed value)
  width?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string;
  emptyMessage?: string | React.ReactNode;
  onRowClick?: (item: T) => void;
}

export default function DataTable<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = 'No data available',
  onRowClick,
}: DataTableProps<T>) {
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  const handleSort = (columnKey: string) => {
    if (sortColumn === columnKey) {
      // Toggle direction
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortColumn(null);
        setSortDirection(null);
      } else {
        setSortDirection('asc');
      }
    } else {
      setSortColumn(columnKey);
      setSortDirection('asc');
    }
  };

  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return data;
    }

    const column = columns.find((col) => col.key === sortColumn);
    if (!column || !column.sortable) {
      return data;
    }

    return [...data].sort((a, b) => {
      // Use sortValue function if provided (matches displayed value), otherwise use raw property
      const aValue = column.sortValue ? column.sortValue(a) : (a as any)[sortColumn];
      const bValue = column.sortValue ? column.sortValue(b) : (b as any)[sortColumn];

      // Handle null/undefined
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return 1;
      if (bValue == null) return -1;

      // Compare values
      let comparison = 0;
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        comparison = aValue.localeCompare(bValue);
      } else if (typeof aValue === 'number' && typeof bValue === 'number') {
        comparison = aValue - bValue;
      } else {
        comparison = String(aValue).localeCompare(String(bValue));
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortColumn, sortDirection, columns]);

  if (data.length === 0) {
    return (
      <div className="data-table-empty">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="data-table-container">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.sortable ? 'sortable' : ''}
                style={{ width: column.width }}
                onClick={() => column.sortable && handleSort(column.key)}
              >
                <div className="th-content">
                  <span>{column.label}</span>
                  {column.sortable && (
                    <span className="sort-indicator">
                      {sortColumn === column.key ? (
                        sortDirection === 'asc' ? '↑' : '↓'
                      ) : (
                        '⇅'
                      )}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item) => (
            <tr
              key={keyExtractor(item)}
              onClick={() => onRowClick?.(item)}
              className={onRowClick ? 'clickable' : ''}
            >
              {columns.map((column) => (
                <td key={column.key} style={{ width: column.width }}>
                  {column.render
                    ? column.render(item)
                    : String((item as any)[column.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

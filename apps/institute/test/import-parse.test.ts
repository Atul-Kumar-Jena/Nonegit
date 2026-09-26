import { describe, expect, it } from 'vitest';
import { parseRows, splitCells } from '../src/import-parse';

describe('bulk import parser', () => {
  it('splits tabs, commas and quoted cells', () => {
    expect(splitCells('a\tb\tc')).toEqual(['a', 'b', 'c']);
    expect(splitCells('"Sharma, Aarav",21CS1,a@x.edu')).toEqual(['Sharma, Aarav', '21CS1', 'a@x.edu']);
    expect(splitCells('"say ""hi"""')).toEqual(['say "hi"']);
  });

  it('recognises cells by shape when there is no header', () => {
    const { rows, problems } = parseRows('Aarav Sharma, 21CS1001, AARAV@College.edu\nDiya Patel\t21CS1002\t+91 98765 43210\tCSE\t5', 'student');
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { role: 'student', fullName: 'Aarav Sharma', rollNo: '21CS1001', email: 'aarav@college.edu' },
      { role: 'student', fullName: 'Diya Patel', rollNo: '21CS1002', phone: '+919876543210', department: 'CSE', semester: 5 },
    ]);
  });

  it('never mistakes an all-digit roll number for a phone number without a header', () => {
    const { rows } = parseRows('Kabir Rao, 2021001234, kabir@x.edu', 'student');
    expect(rows[0]).toMatchObject({ rollNo: '2021001234', email: 'kabir@x.edu' });
    expect(rows[0]?.phone).toBeUndefined();
  });

  it('follows a header row exactly, in any order', () => {
    const { rows } = parseRows('Email,Roll No,Name,Mobile,Sem\nm@x.edu,2021001234,Meera Iyer,9876543210,3', 'student');
    expect(rows).toEqual([{ role: 'student', fullName: 'Meera Iyer', rollNo: '2021001234', email: 'm@x.edu', phone: '+919876543210', semester: 3 }]);
  });

  it('reports rows it cannot use instead of guessing', () => {
    const { rows, problems } = parseRows('Name,Email\nNo Contact,\n,x@y.edu\nBad Mail,not-an-email', 'student');
    expect(rows).toEqual([]);
    expect(problems).toHaveLength(3);
  });

  it('drops student-only fields for teachers', () => {
    const { rows } = parseRows('Dr. Rao, T-42, rao@x.edu', 'teacher');
    expect(rows[0]).toEqual({ role: 'teacher', fullName: 'Dr. Rao', email: 'rao@x.edu', department: 'T-42' });
  });
});

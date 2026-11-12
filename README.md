# CanvAdminTools

Small browser tools for Canvas LMS administrators. Each one runs inside a Canvas tab you are already signed in to, does one job that the Canvas UI makes tedious, and gets out of the way.

**Install page:** https://techconsigliere.github.io/CanvAdminTools/

## Before you run anything from the internet in an admin session

You should be skeptical of a stranger's JavaScript running against your production LMS with your admin permissions. Here is what these do and do not do, so you can verify it yourself rather than take my word for it.

- **No tokens.** There is no API key in any of these files. Authentication is your existing browser session cookie plus the `_csrf_token` cookie that Canvas already set.
- **No third parties.** Every request goes to the Canvas origin in your address bar, resolved at runtime from `location.origin`. Nothing is sent anywhere else. There is no analytics, no telemetry, no phone-home.
- **No remote code.** Nothing is fetched and executed. No `eval`, no injected `<script>` tag. The admin tools inject no `<style>` element either; their interfaces are built with DOM calls, which is also why they work on accounts with Content Security Policy turned on. Quiz accommodations is the exception: it adds a `<style>` element to its own panel, so a strict Content Security Policy can leave that panel unstyled, though it still works.
- **Read the source.** `src/` holds the readable, commented original. `dist/` holds the same code, URL-encoded for the bookmark field, so each build decodes back to its source byte for byte. The build is mechanical and reproducible from the source.
- **Your permissions still apply.** These call the same Canvas API your account already has. If your role cannot cross-list a section, neither can the bookmarklet.

## The tools

### Cross-list sections

Moves sections out of one or more secondary courses and into a primary course, in one pass, without walking the Canvas UI section by section.

- **Version:** 2.1.1
- **Where to run it:** any page on your Canvas instance. It works best from an account page, where it picks up the account ID from the URL.
- **Permissions needed:** a role that can cross-list sections in the courses involved.
- **Last tested:** 2026-09-18, Chrome and Firefox, against a Canvas production instance.

Find the primary course, add up to nine secondary courses, and check the sections you want moved. Sections start unchecked, so every move is opt-in rather than something that happens because you picked the wrong course in an autocomplete. Before anything happens, the panel tells you in plain language how many sections and how many student enrollments are about to move, and which course they will land in.

#### Cross-list before the term opens

Moving a section out of a course that has already started leaves that section's submissions and grades behind in the source course, where those students can no longer reach them. Un-cross-listing returns the section, but it does not reconcile work done in the primary course in the meantime, and the cleanup is manual. Check for submitted work before you move anything in a live course. The panel repeats this warning whenever the selected sections carry student enrollments.

#### What else to know

Cross-listing moves student enrollments, so those students do their coursework in the primary course from that point forward. Source courses keep their own content, settings, and any sections you left unchecked. Nothing is deleted, and Canvas records each section's home course, which is what makes the undo possible. Sections already cross-listed elsewhere are flagged in red, because moving one of those relocates it a second time rather than returning it home.

The panel warns you if a secondary course is the same as the primary course, or if you listed the same secondary course twice, and refuses to proceed until you fix it.

#### Undo and the audit record

After a run, an undo button returns those sections to their home courses. That button lives in the browser tab you ran it in and nowhere else. Close the tab, reload the page, or navigate away, and the undo is gone.

Every completed run also prints a copyable audit record: an ISO timestamp, the destination course with its SIS ID and course code, and one line per section giving the section ID, its SIS ID, and the home course it came from. Copy it into your ticket or change log before you close the tab. It is your change-management artifact, and it is also your manual recovery path, since returning a section by hand means opening the primary course, going to **Settings > Sections**, and de-cross-listing it back to the course named in the record.

### Add or remove one enrollment

Puts one person on one section in one role, or takes them off it, including in courses the enrollments API refuses to touch.

- **Version:** 1.1.1
- **Where to run it:** any page on your Canvas instance. It works best from the account page you actually mean, since SIS imports run at the account level.
- **Permissions needed:** the Import SIS Data permission on your admin role.
- **Last tested:** 2026-09-18, Chrome and Firefox, against a Canvas production instance.

Search for the user, search for the course, pick the section, choose the role and whether you are adding or removing. The panel shows you the exact two-line CSV it will send before you send it, and a plain-language sentence describing what happens.

#### Why a SIS import instead of the enrollments API

`EnrollmentsApiController#create` refuses to add an enrollment to a concluded course. Every fall, someone needs a designer on last spring's section to pull content out of it, and the supported path is to unconclude the course, add the person, and remember to conclude it again later. The SIS importer does not enforce that guard, so a two-row CSV reaches concluded and past-term courses without changing the course state.

#### Read this before you use it

This is the sharpest tool in the repository, and it deserves more caution than the cross-list helper.

The enrollment it creates becomes SIS-managed. Instructors cannot remove an SIS-managed enrollment from their own course. More importantly, a future SIS import running in batch mode can delete it as an orphan, because your nightly feed has never heard of it. Find out how your institution runs its enrollment imports before you use this on a course the SIS still feeds.

The tool never sends `batch_mode` and never sends `diffing_data_set_identifier`. That is what keeps a two-row CSV from ever sweeping a term. Both omissions are deliberate, and they should stay that way in any fork.

SIS imports run at the account level. If you open the panel from a page that does not name an account, it resolves to your root account, and it tells you so in an amber line when you hold admin rights on more than one. Open the account you actually mean and click the bookmarklet from there.

#### Verification and the audit line

After the import finishes, the panel polls for the result, surfaces any processing warnings or errors Canvas returned, and then re-reads the section roster to confirm the enrollment actually landed. A SIS import that reports success while the roster disagrees is the exact case that check exists to catch.

It then prints a one-line audit record carrying the timestamp, the import ID, the role, the status, the user's SIS ID, the section's SIS ID, and the course. Copy it into your ticket before you close the panel.

## Installing

Drag the buttons from the [install page](https://techconsigliere.github.io/CanvAdminTools/) to your bookmarks bar. That is the whole process.

If you would rather not drag a link from a web page, the manual route works identically: show your bookmarks bar (`Ctrl/Cmd+Shift+B`), right-click it, choose **Add page** in Chrome or **Add Bookmark** in Firefox, name it whatever you like, and paste the contents of the matching file in `dist/` into the **URL** field.

Click the bookmark once on a Canvas page to open the panel, and again to close it.

## Canvas changes things

Instructure ships to production every few weeks. These tools call the REST API rather than scraping the page, which makes them more durable than most bookmarklets, but an API behavior change can still break one. Each tool carries a last-tested date above. If something stops working, open an issue with your Canvas instance type, your browser, and what the panel said when it failed.

## What I can promise

I maintain this as time allows, and I read every issue. Treat it as a tool one admin wrote and shared rather than a supported product. Test it against your own instance, on a course that does not matter, before you rely on it during a term.

## Contributing

Issues and pull requests are welcome, particularly from admins at institutions that do not run on a quarter calendar or a Banner SIS. Portability problems are the most useful bug reports I can get.

## License

MIT. Use it, fork it, ship it inside your own admin toolkit, rename it. See [LICENSE](LICENSE).

Maintained by Chris Powell, a Canvas administrator in higher education.

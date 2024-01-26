import { calendar, calendar_v3 } from "@googleapis/calendar";
import { GaxiosPromise, auth as googleAuth } from "@googleapis/oauth2";
import { AdapterInstance } from "@iobroker/adapter-core";
import { CalendarEvent, ICalendarTimeRangObj } from "./calendarManager";
//const scope = "https://www.googleapis.com/auth/calendar";

let adapter: AdapterInstance;
let localTimeZone: string;
export function initLib(adapterInstance: AdapterInstance, adapterLocalTimeZone: string): void {
	adapter = adapterInstance;
	localTimeZone = adapterLocalTimeZone;
}

export class GoogleCalendarEvent extends CalendarEvent {
	googleEvent: calendar_v3.Schema$Event | null;
	constructor(googleEvent: calendar_v3.Schema$Event, calendarName: string, endDate: Date) {
		super(endDate, calendarName, googleEvent.id || null);
		this.googleEvent = googleEvent;
		try {
			this.summary = googleEvent.summary || "";
			this.description = googleEvent.description || "";
			try {
				if (googleEvent.colorId) {
					let color = googleColors.event[googleEvent.colorId];
					this.fgColor = color.foreground;
					this.bgColor = color.background;
				}
			} catch (error) {}
		} catch (error) {
			adapter.log.error("could not read calendar Event: " + error);
			adapter.log.debug(JSON.stringify(googleEvent));
			this.googleEvent = null;
		}
	}
	getNextTimeObj(isFirstCall: boolean): ICalendarTimeRangObj | null {
		if (!this.googleEvent || !isFirstCall) {
			return null;
		}
		let start: Date;
		let end: Date;
		if (this.googleEvent.start) {
			if (this.googleEvent.start.date) {
				start = new Date(this.googleEvent.start.date + "T00:00");
			} else {
				start = new Date(this.googleEvent.start.dateTime || "");
			}
		} else {
			start = new Date();
		}
		if (this.googleEvent.end) {
			if (this.googleEvent.end.date) {
				end = new Date(this.googleEvent.end.date + "T23:59");
			} else {
				end = new Date(this.googleEvent.end.dateTime || "");
			}
		} else {
			end = new Date();
		}
		return {
			startDate: start,
			endDate: end,
		};
	}
}

export class GoogleCalendar implements webcal.ICalendarBase {
	client: calendar_v3.Calendar;
	auth;
	calendarId: string | undefined;
	name: string;

	constructor(calConfig: webcal.IConfigCalendar) {
		this.name = calConfig.name;
		this.auth = new googleAuth.OAuth2(calConfig.clientId, calConfig.password);
		this.auth.setCredentials({
			refresh_token: calConfig.refreshToken,
		});
		this.client = calendar({
			version: "v3",
			auth: this.auth,
		});
	}

	/**
	 * load Calendars from Server
	 * @param displayName if set, try to return Calendar with this name
	 * @returns Calender by displaName or primary Calendar
	 */
	private async getCalendar(displayName?: string): Promise<string> {
		if (!this.calendarId) {
			const res = await this.client.calendarList.list();
			if (res && res.data && res.data.items) {
				const calendars = res.data.items;
				//console.log(calendars)
				if (!displayName) {
					displayName = this.name;
				}

				if (displayName) {
					const displayNameLowerCase = displayName.toLocaleLowerCase();

					for (let i = 0; i < calendars.length; i++) {
						if (
							calendars[i].summary?.toLowerCase() == displayNameLowerCase ||
							calendars[i].summaryOverride?.toLowerCase() == displayNameLowerCase
						) {
							this.calendarId = calendars[i].id || "";
							adapter.log.info("use google calendar " + this.calendarId);
							return this.calendarId;
						}
					}
				}

				for (let i = 0; i < calendars.length; i++) {
					if (calendars[i].primary) {
						this.calendarId = calendars[i].id || "";
						adapter.log.info("use google primary calendar " + this.calendarId);
						break;
					}
				}
			}
		}
		return this.calendarId || "";
	}

	/**
	 * fetch Events form Calendar
	 * @param startDate as date object
	 * @param endDate as date object
	 * @returns Array of Calenderobjects
	 */
	private async getCalendarObjects(
		startDateISOString: string,
		endDateISOString: string,
	): GaxiosPromise<calendar_v3.Schema$Events> {
		const searchParams: any = {
			calendarId: await this.getCalendar(),
			singleEvents: true,
			orderBy: "startTime",
			timeZone: localTimeZone,
		};
		if (startDateISOString) {
			searchParams.timeMin = startDateISOString;
			searchParams.timeMax = endDateISOString;
		}
		return this.client.events.list(searchParams);
	}

	loadEvents(calEvents: webcal.ICalendarEventBase[], startDate: Date, endDate: Date): Promise<string | null> {
		return this.getCalendarObjects(startDate.toISOString(), endDate.toISOString())
			.then((res) => {
				const calendarObjects = res?.data?.items;
				if (calendarObjects) {
					adapter.log.info("found " + calendarObjects.length + " calendar objects");
					for (const i in calendarObjects) {
						calEvents.push(new GoogleCalendarEvent(calendarObjects[i], this.name, endDate));
					}
				}
				return null;
			})
			.catch((reason) => {
				return reason.message;
			});
	}
	async addEvent(calEvent: webcal.ICalendarEventData): Promise<any> {
		let result;
		try {
			const start =
				typeof calEvent.startDate == "string"
					? calEvent.startDate
					: CalendarEvent.getDateTimeISOStringFromEventDateTime(calEvent.startDate);
			const data: calendar_v3.Schema$Event = {
				summary: calEvent.summary,
				description: calEvent.description || "ioBroker webCal",
			};
			if (start.length > 10) {
				data.start = { dateTime: start, timeZone: localTimeZone };
			} else {
				data.start = { date: start };
			}
			if (calEvent.endDate) {
				const end =
					typeof calEvent.endDate == "string"
						? calEvent.endDate
						: CalendarEvent.getDateTimeISOStringFromEventDateTime(calEvent.endDate);
				if (end.length > 10) {
					data.end = { dateTime: end, timeZone: localTimeZone };
				} else {
					data.end = { date: end };
				}
			} else {
				data.end = data.start;
			}

			const res = await this.client.events.insert({
				calendarId: await this.getCalendar(),
				requestBody: data,
			});
			result = {
				ok: !!res.data,
				message: res.statusText,
			};
		} catch (error) {
			result = {
				ok: false,
				message: (error as { message: string }).message,
			};
		}

		//console.log(result);
		//console.log(result.ok);
		return result;
	}

	/**
	 * delte Event from Calendar
	 * @param id event id
	 * @returns Server response, like {ok:boolen}
	 */
	async deleteEvent(id: string): Promise<any> {
		let result;
		try {
			const res = await this.client.events.delete({
				calendarId: await this.getCalendar(),
				eventId: id,
			});
			result = {
				ok: res.status >= 200 && res.status < 300,
				message: res.statusText,
			};
		} catch (error) {
			result = {
				ok: false,
				message: (error as { message: string }).message,
			};
		}

		//console.log(result);
		//console.log(result.ok);
		return result;
	}
}

const googleColors = {
	"kind": "calendar#colors",
	"updated": "2012-02-14T00:00:00.000Z",
	"calendar": {
		"24": {
			"foreground": "#1d1d1d",
			"background": "#a47ae2"
		},
		"20": {
			"foreground": "#1d1d1d",
			"background": "#cabdbf"
		},
		"21": {
			"foreground": "#1d1d1d",
			"background": "#cca6ac"
		},
		"22": {
			"foreground": "#1d1d1d",
			"background": "#f691b2"
		},
		"23": {
			"foreground": "#1d1d1d",
			"background": "#cd74e6"
		},
		"1": {
			"foreground": "#1d1d1d",
			"background": "#ac725e"
		},
		"3": {
			"foreground": "#1d1d1d",
			"background": "#f83a22"
		},
		"2": {
			"foreground": "#1d1d1d",
			"background": "#d06b64"
		},
		"5": {
			"foreground": "#1d1d1d",
			"background": "#ff7537"
		},
		"4": {
			"foreground": "#1d1d1d",
			"background": "#fa573c"
		},
		"7": {
			"foreground": "#1d1d1d",
			"background": "#42d692"
		},
		"6": {
			"foreground": "#1d1d1d",
			"background": "#ffad46"
		},
		"9": {
			"foreground": "#1d1d1d",
			"background": "#7bd148"
		},
		"8": {
			"foreground": "#1d1d1d",
			"background": "#16a765"
		},
		"11": {
			"foreground": "#1d1d1d",
			"background": "#fbe983"
		},
		"10": {
			"foreground": "#1d1d1d",
			"background": "#b3dc6c"
		},
		"13": {
			"foreground": "#1d1d1d",
			"background": "#92e1c0"
		},
		"12": {
			"foreground": "#1d1d1d",
			"background": "#fad165"
		},
		"15": {
			"foreground": "#1d1d1d",
			"background": "#9fc6e7"
		},
		"14": {
			"foreground": "#1d1d1d",
			"background": "#9fe1e7"
		},
		"17": {
			"foreground": "#1d1d1d",
			"background": "#9a9cff"
		},
		"16": {
			"foreground": "#1d1d1d",
			"background": "#4986e7"
		},
		"19": {
			"foreground": "#1d1d1d",
			"background": "#c2c2c2"
		},
		"18": {
			"foreground": "#1d1d1d",
			"background": "#b99aff"
		}
	},
	"event": {
		"11": {
			"foreground": "#1d1d1d",
			"background": "#dc2127"
		},
		"10": {
			"foreground": "#1d1d1d",
			"background": "#51b749"
		},
		"1": {
			"foreground": "#1d1d1d",
			"background": "#a4bdfc"
		},
		"3": {
			"foreground": "#1d1d1d",
			"background": "#dbadff"
		},
		"2": {
			"foreground": "#1d1d1d",
			"background": "#7ae7bf"
		},
		"5": {
			"foreground": "#1d1d1d",
			"background": "#fbd75b"
		},
		"4": {
			"foreground": "#1d1d1d",
			"background": "#ff887c"
		},
		"7": {
			"foreground": "#1d1d1d",
			"background": "#46d6db"
		},
		"6": {
			"foreground": "#1d1d1d",
			"background": "#ffb878"
		},
		"9": {
			"foreground": "#1d1d1d",
			"background": "#5484ed"
		},
		"8": {
			"foreground": "#1d1d1d",
			"background": "#e1e1e1"
		}
	}
};

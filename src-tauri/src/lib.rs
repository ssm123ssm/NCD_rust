use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const STANDARDIZATION_REFERENCE_YEAR: i32 = 2012;
const CVS_CAUSE_CODES: &[&str] = &["125", "128", "129", "132", "134"];
const CANCER_CAUSE_CODES_M: &[&str] = &["050", "053", "059", "069", "051"];
const CANCER_CAUSE_CODES_F: &[&str] = &["064", "076", "053", "066", "065"];

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            query_data,
            query_population_data,
            test_read_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// A struct to store IMMR_code	Disease	live_f_17-49	live_f_50-69	live_f_70+	live_f_NA	live_f_Total	year

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Record {
    IMMR_code: String,
    Disease: String,
    live_17_49: f64,
    live_50_69: f64,
    live_70_plus: f64,
    live_NA: f64,
    live_Total: f64,
    year: i32,
}

// A struct to strore each CSV file, with the file name and a vector of Record structs
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CsvData {
    file_name: String,
    records: Vec<Record>,
    sex: String,
    disease: String,
}

//A function to read the csv file, get the value in each row and return a vector of Record structs
fn read_csv(file_path: &Path) -> Result<CsvData, Box<dyn std::error::Error>> {
    let mut rdr = csv::Reader::from_path(file_path)?;
    let mut records = Vec::new();
    
    // get the headers
    let headers = rdr.headers()?.clone();

    // the headers do not match the struct field names, so we need to map them
    for result in rdr.records() {
        let record = result?;
        let rec = Record {
            IMMR_code: record.get(0).unwrap_or("").to_string(),
            Disease: record.get(1).unwrap_or("").to_string(),
            live_17_49: record.get(2).unwrap_or("0").parse::<f64>().unwrap_or(0.0),
            live_50_69: record.get(3).unwrap_or("0").parse::<f64>().unwrap_or(0.0),
            live_70_plus: record.get(4).unwrap_or("0").parse::<f64>().unwrap_or(0.0),
            live_NA: record.get(5).unwrap_or("0").parse::<f64>().unwrap_or(0.0),
            live_Total: record.get(6).unwrap_or("0").parse::<f64>().unwrap_or(0.0),
            year: record.get(7).unwrap_or("0").parse::<i32>().unwrap_or(0),
        };
        records.push(rec);
    }   

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    Ok(CsvData {
        file_name: file_path.to_string_lossy().to_string(),
        records,
        // extract sex from file name, the file name is in the format "disease_filtered_m.csv"
        sex: file_name
            .split('_')
            .nth(2)
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("")
            .to_string(),
        disease: file_name.split('_').next().unwrap_or("").to_string(),
    })
}

fn resolve_data_dx_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundled_dir = resource_dir.join("resources").join("data_dx");
    if bundled_dir.exists() {
        return Ok(bundled_dir);
    }

    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let dev_candidates = [
        cwd.join("src-tauri").join("resources").join("data_dx"),
        cwd.join("resources").join("data_dx"),
    ];

    for candidate in dev_candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not locate data directory. Checked bundled path '{}' and dev paths relative to '{}'.",
        bundled_dir.display(),
        cwd.display()
    ))
}

// a function to get all the csv files in the resources/data_dx folder and read them, return a vector of CsvData structs
fn read_all_csv_files(data_dir: &Path) -> Result<Vec<CsvData>, String> {
    let mut csv_data_vec = Vec::new();
    let paths = std::fs::read_dir(data_dir).map_err(|e| e.to_string())?;
    for path in paths {
        let path = path.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("csv") {
            let csv_data = read_csv(&path).map_err(|e| e.to_string())?;
            csv_data_vec.push(csv_data);    
            print!("Read CSV file: {}. Disease: {}, Sex: {}\n", &csv_data_vec.last().unwrap().file_name, &csv_data_vec.last().unwrap().disease, &csv_data_vec.last().unwrap().sex);
        }
    }
    Ok(csv_data_vec)
}

static CSV_DATA_CACHE: OnceLock<Result<Vec<CsvData>, String>> = OnceLock::new();

fn get_cached_csv_data(app: &AppHandle) -> Result<&'static Vec<CsvData>, String> {
    let data_dir = resolve_data_dx_dir(app)?;
    match CSV_DATA_CACHE.get_or_init(|| read_all_csv_files(&data_dir)) {
        Ok(csv_data_vec) => Ok(csv_data_vec),
        Err(err) => Err(err.clone()),
    }
}

fn aggregate_admissions_for_selection(
    csv_data_vec: &[CsvData],
    disease: &str,
    sex: &str,
    cause_codes: Option<&[String]>,
) -> Result<Vec<(i32, f64, f64, f64, f64, f64)>, String> {
    for csv_data in csv_data_vec {
        if csv_data.disease == disease && csv_data.sex == sex {
            let mut yearly_totals: BTreeMap<i32, (f64, f64, f64, f64, f64)> = BTreeMap::new();

            for record in &csv_data.records {
                if let Some(codes) = cause_codes {
                    let record_code = normalize_immr_code(&record.IMMR_code);
                    if !codes.iter().any(|code| normalize_immr_code(code) == record_code) {
                        continue;
                    }
                }

                let totals = yearly_totals
                    .entry(record.year)
                    .or_insert((0.0, 0.0, 0.0, 0.0, 0.0));

                totals.0 += record.live_17_49;
                totals.1 += record.live_50_69;
                totals.2 += record.live_70_plus;
                totals.3 += record.live_NA;
                totals.4 = totals.0 + totals.1 + totals.2;
            }

            let result = yearly_totals
                .into_iter()
                .map(
                    |(year, (live_17_49, live_50_69, live_70_plus, live_na, live_total))| {
                        (
                            year,
                            live_17_49,
                            live_50_69,
                            live_70_plus,
                            live_na,
                            live_total,
                        )
                    },
                )
                .collect();

            return Ok(result);
        }
    }

    Err(format!("No data found for disease: {} and sex: {}", disease, sex))
}

fn build_population_map(
    population: Vec<(i32, f64, f64, f64, f64)>,
) -> BTreeMap<i32, (f64, f64, f64, f64)> {
    population
        .into_iter()
        .map(|(year, pop_17_49, pop_50_69, pop_70_plus, pop_total)| {
            (year, (pop_17_49, pop_50_69, pop_70_plus, pop_total))
        })
        .collect()
}

fn safe_divide(numerator: f64, denominator: f64) -> f64 {
    if denominator > 0.0 {
        numerator / denominator
    } else {
        0.0
    }
}

fn documented_cause_codes(disease: &str, sex: &str) -> Vec<String> {
    match disease {
        "cvs" => CVS_CAUSE_CODES.iter().map(|code| (*code).to_string()).collect(),
        "cancer" => match sex {
            "m" => CANCER_CAUSE_CODES_M
                .iter()
                .map(|code| (*code).to_string())
                .collect(),
            "f" => CANCER_CAUSE_CODES_F
                .iter()
                .map(|code| (*code).to_string())
                .collect(),
            _ => {
                let mut codes: Vec<String> = CANCER_CAUSE_CODES_M
                    .iter()
                    .chain(CANCER_CAUSE_CODES_F.iter())
                    .map(|code| (*code).to_string())
                    .collect();
                codes.sort();
                codes.dedup();
                codes
            }
        },
        _ => Vec::new(),
    }
}

fn normalize_immr_code(value: &str) -> String {
    let trimmed = value.trim().to_uppercase();
    if !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        format!("{:03}", trimmed.parse::<u32>().unwrap_or(0))
    } else {
        trimmed
    }
}

fn resolve_cause_code_filter(
    disease: &str,
    sex: &str,
    cause_codes: Option<Vec<String>>,
) -> Option<Vec<String>> {
    let selected = cause_codes?;
    if selected.is_empty() || selected.iter().any(|code| code == "__all__") {
        return None;
    }

    if selected.iter().any(|code| code == "__all_doc__") {
        let codes = documented_cause_codes(disease, sex);
        if codes.is_empty() {
            return None;
        }
        return Some(codes.into_iter().map(|code| normalize_immr_code(&code)).collect());
    }

    Some(
        selected
            .into_iter()
            .map(|code| normalize_immr_code(&code))
            .collect(),
    )
}

// A query function to get the records of a specific disease and sex. Should return a vector of years, live_17_49, live_50_69, live_70_plus, live_NA, live_Total in a way that can be easily used by the frontend to plot the graph. The function should take the disease and sex as parameters.
#[tauri::command]
fn query_data(
    app: AppHandle,
    disease: &str,
    sex: &str,
    metric: Option<&str>,
    cause_codes: Option<Vec<String>>,
) -> Result<Vec<(i32, f64, f64, f64, f64, f64)>, String> {
    let csv_data_vec = get_cached_csv_data(&app)?;
    let cause_filter = resolve_cause_code_filter(disease, sex, cause_codes);
    let admissions = aggregate_admissions_for_selection(
        csv_data_vec,
        disease,
        sex,
        cause_filter.as_deref(),
    )?;
    let metric = metric.unwrap_or("admissions");

    if metric == "crude_rates" || metric == "rates" || metric == "standardized_rates" {
        let population = query_population_data(app, sex)?;
        let population_by_year = build_population_map(population);
        let reference_population = population_by_year
            .get(&STANDARDIZATION_REFERENCE_YEAR)
            .copied()
            .ok_or_else(|| {
                format!(
                    "No population data found for reference year {} and sex '{}'",
                    STANDARDIZATION_REFERENCE_YEAR, sex
                )
            })?;
        let reference_total =
            reference_population.0 + reference_population.1 + reference_population.2;
        let reference_weights = if reference_total > 0.0 {
            (
                reference_population.0 / reference_total,
                reference_population.1 / reference_total,
                reference_population.2 / reference_total,
            )
        } else {
            return Err(format!(
                "Reference population total is zero for year {} and sex '{}'",
                STANDARDIZATION_REFERENCE_YEAR, sex
            ));
        };

        return admissions
            .into_iter()
            .map(
                |(year, live_17_49, live_50_69, live_70_plus, live_na, live_total)| {
                    let (pop_17_49, pop_50_69, pop_70_plus, pop_total) =
                        population_by_year.get(&year).copied().ok_or_else(|| {
                            format!("No population data found for sex '{}' and year {}", sex, year)
                        })?;

                    let rate_17_49 = safe_divide(live_17_49, pop_17_49);
                    let rate_50_69 = safe_divide(live_50_69, pop_50_69);
                    let rate_70_plus = safe_divide(live_70_plus, pop_70_plus);
                    let crude_rate_total = safe_divide(live_total, pop_total);
                    let standardized_rate_total = rate_17_49 * reference_weights.0
                        + rate_50_69 * reference_weights.1
                        + rate_70_plus * reference_weights.2;
                    let output_total = if metric == "standardized_rates" {
                        standardized_rate_total
                    } else {
                        crude_rate_total
                    };

                    Ok((
                        year,
                        rate_17_49,
                        rate_50_69,
                        rate_70_plus,
                        live_na,
                        output_total,
                    ))
                },
            )
            .collect();
    }

    Ok(admissions)
}

// a function to read population data from a csv and save them Pop_struct
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct PopRecord {
    year: i32,
    pop_17_49: f64,
    pop_50_69: f64,
    pop_70_plus: f64,
    pop_Total: f64,
}

// A struct to store the population struct vaector for each sex
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct PopData {
    sex: String,
    records: Vec<PopRecord>,
}

fn parse_csv_number(value: &str) -> f64 {
    value.parse::<f64>().unwrap_or(0.0)
}

fn normalize_age_label(label: &str) -> &str {
    match label.trim() {
        "17 - 49" => "17_49",
        "50 - 69" => "50_69",
        "70+" => "70_plus",
        "Total" => "total",
        _ => "",
    }
}

// function to read the population csv file. The columns will be age_cat_2	female_2004	female_2005	female_2006	female_2007	female_2008	female_2009	female_2010	female_2011	female_2012	female_2013	female_2014	female_2015	female_2016	female_2017	female_2018	female_2019	female_2020	female_2021	female_2022, but changes based on sex. There is a row each 17 - 49 50 - 69 70+ and Total. The function should take a file name (like pop_sum_f.csv) and return a PopData struct.
fn read_population_csv(file_path: &Path) -> Result<PopData, String> {
    let mut rdr = csv::Reader::from_path(file_path).map_err(|e| e.to_string())?;
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();

    let years: Vec<i32> = headers
        .iter()
        .skip(1)
        .map(|header| {
            header
                .split('_')
                .last()
                .unwrap_or("0")
                .parse::<i32>()
                .unwrap_or(0)
        })
        .collect();

    let mut pop_17_49 = vec![0.0; years.len()];
    let mut pop_50_69 = vec![0.0; years.len()];
    let mut pop_70_plus = vec![0.0; years.len()];
    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        let age_cat = normalize_age_label(record.get(0).unwrap_or(""));

        for (index, value) in record.iter().skip(1).enumerate() {
            let parsed = parse_csv_number(value);
            match age_cat {
                "17_49" => pop_17_49[index] = parsed,
                "50_69" => pop_50_69[index] = parsed,
                "70_plus" => pop_70_plus[index] = parsed,
                _ => {}
            }
        }
    }

    let records = years
        .iter()
        .enumerate()
        .map(|(index, year)| PopRecord {
            year: *year,
            pop_17_49: pop_17_49[index],
            pop_50_69: pop_50_69[index],
            pop_70_plus: pop_70_plus[index],
            pop_Total: pop_17_49[index] + pop_50_69[index] + pop_70_plus[index],
        })
        .collect();

    Ok(PopData {
        sex: file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .split('_')
            .nth(2)
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("")
            .to_string(),
        records,
    })
}

fn resolve_data_pop_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundled_dir = resource_dir.join("resources").join("data_pop");
    if bundled_dir.exists() {
        return Ok(bundled_dir);
    }

    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let dev_candidates = [
        cwd.join("src-tauri").join("resources").join("data_pop"),
        cwd.join("resources").join("data_pop"),
    ];

    for candidate in dev_candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not locate population data directory. Checked bundled path '{}' and dev paths relative to '{}'.",
        bundled_dir.display(),
        cwd.display()
    ))
}

// a function to query the population data by sex and return a vector of years, pop_17_49, pop_50_69, pop_70_plus, pop_Total in a way that can be easily used by the frontend to plot the graph. The function should take the sex as a parameter.
#[tauri::command]
fn query_population_data(app: AppHandle, sex: &str) -> Result<Vec<(i32, f64, f64, f64, f64)>, String> {
    let pop_dir = resolve_data_pop_dir(&app)?;
    let pop_file = pop_dir.join(format!("pop_sum_{}.csv", sex));
    let pop_data = read_population_csv(&pop_file)?;
    let result = pop_data
        .records
        .iter()
        .map(|record| {
            (record.year, record.pop_17_49, record.pop_50_69, record.pop_70_plus, record.pop_Total)
        })
        .collect();
    Ok(result)
}


// A test function
#[tauri::command]
fn test_read_csv(app: AppHandle) -> Result<String, String> {
    // testing read_population_csv
    let pop_dir = resolve_data_pop_dir(&app)?;
    let pop_file = pop_dir.join("pop_sum_f.csv");
    let pop_data = read_population_csv(&pop_file)?;
    print!("Read population CSV file: {}. Sex: {}, Records: {:?}\n", pop_file.display(), pop_data.sex, pop_data.records);

    Ok("Successfully read population CSV file".into())
}

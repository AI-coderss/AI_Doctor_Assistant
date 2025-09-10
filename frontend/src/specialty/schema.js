// src/specialty/schema.js
// Guideline-aligned compact schemas (2024–2025 era).
// ACC/AHA chest pain; GINA 2024 (asthma); GOLD 2024 (COPD);
// ADA 2025 (diabetes); KDIGO 2024 (CKD); NICE NG84 (sore throat);
// WHO ANC; AAP pediatric acute visit.
// Central place for all specialty form definitions.
// Each specialty = practical clinic-ready fields, grouped into 4 UX steps.

export const FIELD_TYPES = {
  TEXT: "text",
  TEXTAREA: "textarea",
  NUMBER: "number",
  DATE: "date",
  SELECT: "select",
  RADIO: "radio",
  MULTISELECT: "multiselect",
  TOGGLE: "toggle",
};

// ---------------- Common options ----------------
const YES_NO = ["Yes", "No"];
const YES_NO_NA = ["Yes", "No", "N/A"];
const SEX = ["Male", "Female"];
const SEVERITY = ["Mild", "Moderate", "Severe"];
const PAIN_SCALE = ["0","1","2","3","4","5","6","7","8","9","10"];
const DURATION_SHORT = ["<24h", "1–7 days", "1–4 weeks", ">1 month"];
const DURATION_GENERAL = ["<1 week","1–4 weeks","1–3 months",">3 months"];
const FEVER_PATTERN = ["None","Low-grade","High (>39°C)","Intermittent","Persistent"];
const ROUTE = ["Oral","IV","IM","Nebulized","Topical"];
const VACC_STATUS = ["Up-to-date","Incomplete","Unknown"];
const FEEDING = ["Breast","Formula","Mixed","Solid age-appropriate"];
const DEVELOPMENT = ["Gross motor delay","Fine motor delay","Speech delay","Social delay","Age-appropriate"];
const SMOKING_STATUS = ["Never","Former","Current"];
const BP_PLACEHOLDER = "e.g., 120/80";

// ---------------- Labels (human-readable) ----------------
export const SPECIALTY_LABELS = {
  // Medicine
  cardiology: "Cardiology",
  endocrinology: "Endocrinology",
  gastroenterology: "Gastroenterology",
  hematology: "Hematology",
  "infectious disease": "Infectious Disease",
  nephrology: "Nephrology",
  neurology: "Neurology",
  pulmonology: "Pulmonology",
  rheumatology: "Rheumatology",

  // Surgery
  "general surgery": "General Surgery",
  orthopedics: "Orthopedics",
  urology: "Urology",
  neurosurgery: "Neurosurgery",
  "cardiothoracic surgery": "Cardiothoracic Surgery",

  // Women & Children
  obgyn: "Obstetrics & Gynecology",
  pediatrics: "Pediatrics",
  neonatology: "Neonatology",
  "reproductive medicine": "Reproductive Medicine (IVF)",

  // Primary & Mental Health
  "family medicine": "Family Medicine",
  geriatrics: "Geriatrics",
  psychiatry: "Psychiatry",
  "addiction medicine": "Addiction Medicine",

  // Sense & Skin
  dermatology: "Dermatology",
  ophthalmology: "Ophthalmology",
  ent: "ENT",
};

// ---------------- Schemas ----------------

// Pediatrics (acute care / general OPD)
const SCHEMA_PEDIATRICS = {
  title: "Pediatrics Visit",
  steps: [
    {
      id: "peds-visit-demo",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Fever, cough, poor feeding…" },
        { id: "age_months", label: "Age (months)", type: FIELD_TYPES.NUMBER, required: true, unit: "months" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX, required: true },
        { id: "weight", label: "Weight", type: FIELD_TYPES.NUMBER, unit: "kg", required: true },
        { id: "height", label: "Height/Length", type: FIELD_TYPES.NUMBER, unit: "cm" },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
        { id: "rr", label: "Respiratory Rate", type: FIELD_TYPES.NUMBER, unit: "breaths/min" },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "beats/min" },
        { id: "spo2", label: "SpO₂", type: FIELD_TYPES.NUMBER, unit: "%" },
      ],
    },
    {
      id: "peds-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true, placeholder: "Onset, duration, course, associated symptoms…" },
        { id: "fever_pattern", label: "Fever Pattern", type: FIELD_TYPES.SELECT, options: FEVER_PATTERN },
        { id: "feeding", label: "Feeding", type: FIELD_TYPES.SELECT, options: FEEDING },
        { id: "hydration", label: "Hydration Signs", type: FIELD_TYPES.MULTISELECT, options: ["Normal tears","Dry mucosa","Sunken eyes","Decreased urine","Lethargy"] },
        { id: "diapers_24h", label: "Wet Diapers (last 24h)", type: FIELD_TYPES.NUMBER },
        { id: "immunization", label: "Immunization Status", type: FIELD_TYPES.SELECT, options: VACC_STATUS },
        { id: "daycare", label: "Attends Daycare", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "sick_contacts", label: "Sick Contacts", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "dev", label: "Developmental Milestones", type: FIELD_TYPES.MULTISELECT, options: DEVELOPMENT },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA, placeholder: "Drug/food allergies and reactions" },
        { id: "pmh", label: "Past Medical History", type: FIELD_TYPES.TEXTAREA, placeholder: "Asthma, prematurity, congenital issues…" },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA, placeholder: "Dose, frequency, last dose taken…" },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Poor perfusion","Lethargy","Grunting","Chest indrawing","Apnea","Convulsion"] },
      ],
    },
    {
      id: "peds-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "gen_appearance", label: "General Appearance", type: FIELD_TYPES.SELECT, options: ["Alert","Irritable","Lethargic","Toxic-appearing"] },
        { id: "work_of_breathing", label: "Work of Breathing", type: FIELD_TYPES.SELECT, options: ["Normal","Mild ↑","Moderate ↑","Severe ↑"] },
        { id: "wheeze", label: "Wheeze", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "crackle", label: "Crackles", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "ear_findings", label: "Ear/Throat Findings", type: FIELD_TYPES.MULTISELECT, options: ["AOM signs","Pharyngitis","Tonsillar exudates","None"] },
        { id: "skin_findings", label: "Skin Findings", type: FIELD_TYPES.MULTISELECT, options: ["Rash","Mottling","Petechiae","None"] },
      ],
    },
    {
      id: "peds-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs to Consider", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CRP/ESR","Blood culture","Urinalysis","RSV/Flu test","COVID antigen/PCR"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Chest X-ray","Neck X-ray","None"] },
        { id: "severity", label: "Severity", type: FIELD_TYPES.RADIO, options: SEVERITY },
        { id: "home_care", label: "Home Care Education Given", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA, placeholder: "Any additional considerations…" },
      ],
    },
  ],
};

// OBGYN (general clinic / early pregnancy)
const SCHEMA_OBGYN = {
  title: "Obstetrics & Gynecology Visit",
  steps: [
    {
      id: "obgyn-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "lmp", label: "Last Menstrual Period (LMP)", type: FIELD_TYPES.DATE },
        { id: "pregnant", label: "Pregnant", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "g_p", label: "Gravida / Para", type: FIELD_TYPES.TEXT, placeholder: "e.g., G3P1" },
        { id: "ga_weeks", label: "Gestational Age (if pregnant)", type: FIELD_TYPES.NUMBER, unit: "weeks" },
      ],
    },
    {
      id: "obgyn-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "bleeding", label: "Vaginal Bleeding", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "pain", label: "Pelvic/Abdominal Pain", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "discharge", label: "Abnormal Discharge", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "sti_history", label: "STI History", type: FIELD_TYPES.MULTISELECT, options: ["Chlamydia","Gonorrhea","HSV","Syphilis","HPV","None"] },
        { id: "contraception", label: "Contraception", type: FIELD_TYPES.SELECT, options: ["None","OCP","IUD","Implant","Barrier"] },
        { id: "ob_history", label: "OB History", type: FIELD_TYPES.TEXTAREA, placeholder: "Miscarriages, ectopic, C-section, complications…" },
        { id: "gyne_history", label: "GYNE History", type: FIELD_TYPES.TEXTAREA, placeholder: "Fibroids, PCOS, endometriosis, surgeries…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "obgyn-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "bpm" },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
        { id: "abd_tender", label: "Abdominal Tenderness", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "speculum_exam", label: "Speculum Exam Needed", type: FIELD_TYPES.TOGGLE },
        { id: "preg_test", label: "Urine β-hCG", type: FIELD_TYPES.SELECT, options: ["Not done","Negative","Positive"] },
      ],
    },
    {
      id: "obgyn-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","β-hCG (quant)","Rh type & screen","Urinalysis","STI panel"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Pelvic US","Transvaginal US","None"] },
        { id: "treatment_route", label: "Preferred Treatment Route", type: FIELD_TYPES.SELECT, options: ROUTE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Cardiology (chest pain / dyspnea clinic)
const SCHEMA_CARDIOLOGY = {
  title: "Cardiology Visit",
  steps: [
    {
      id: "cardio-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX, required: true },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "bpm" },
        { id: "spo2", label: "SpO₂", type: FIELD_TYPES.NUMBER, unit: "%" },
      ],
    },
    {
      id: "cardio-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pain_type", label: "Chest Pain Character", type: FIELD_TYPES.SELECT, options: ["Typical angina","Atypical chest pain","Non-cardiac","No pain"] },
        { id: "pain_duration", label: "Pain Duration", type: FIELD_TYPES.SELECT, options: ["<10 min","10–30 min",">30 min","Constant"] },
        { id: "exertional", label: "Exertional Symptoms", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "risk_factors", label: "Risk Factors", type: FIELD_TYPES.MULTISELECT, options: ["HTN","DM","Dyslipidemia","Smoking","FHx CAD","Obesity"] },
        { id: "pmh", label: "Cardiac PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "MI, PCI/CABG, HF, arrhythmias…" },
        { id: "meds", label: "Current Cardiac Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "Antiplatelets, statins, beta-blockers…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "cardio-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "jvp", label: "JVP Elevated", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "edema", label: "Peripheral Edema", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "murmur", label: "Murmur", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "rales", label: "Lung Rales", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "ecg_done", label: "ECG Done", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "cardio-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["Troponin","BNP/NT-proBNP","Lipid panel","HbA1c","CMP"] },
        { id: "imaging", label: "Imaging/Tests", type: FIELD_TYPES.MULTISELECT, options: ["CXR","Echocardiogram","Stress test","CTCA"] },
        { id: "severity", label: "Clinical Severity", type: FIELD_TYPES.RADIO, options: SEVERITY },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Endocrinology (diabetes/thyroid/metabolic)
const SCHEMA_ENDOCRINOLOGY = {
  title: "Endocrinology Visit",
  steps: [
    {
      id: "endo-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
        { id: "weight", label: "Weight", type: FIELD_TYPES.NUMBER, unit: "kg" },
        { id: "height", label: "Height", type: FIELD_TYPES.NUMBER, unit: "cm" },
      ],
    },
    {
      id: "endo-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true, placeholder: "Diabetes/thyroid symptoms, onset, duration…" },
        { id: "dm_type", label: "Diabetes Type", type: FIELD_TYPES.SELECT, options: ["None","Type 1","Type 2","Gestational","Prediabetes"] },
        { id: "hypo_symptoms", label: "Hypoglycemia Symptoms", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "thyroid_symptoms", label: "Thyroid Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Weight change","Heat/cold intolerance","Palpitations","Constipation","Hair loss","Menstrual changes"] },
        { id: "pmh", label: "Endocrine PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "DKA, thyroid surgery, pituitary issues…" },
        { id: "meds", label: "Current Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "Insulin, metformin, SGLT2, GLP-1, levothyroxine…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
        { id: "lifestyle", label: "Lifestyle", type: FIELD_TYPES.MULTISELECT, options: ["Diet counseling","Exercise","Smoking","Alcohol"] },
      ],
    },
    {
      id: "endo-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "bmi", label: "BMI (if known)", type: FIELD_TYPES.NUMBER },
        { id: "foot_exam", label: "Diabetic Foot Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Neuropathy","Ulcer","Callus","Deformity"] },
        { id: "thyroid_exam", label: "Thyroid Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Goiter","Nodules","Tender"] },
      ],
    },
    {
      id: "endo-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["HbA1c","FBS/PPBS","TSH/FT4","Lipid panel","UACR","CMP"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Thyroid US","DXA","Pituitary MRI","None"] },
        { id: "severity", label: "Control Status", type: FIELD_TYPES.SELECT, options: ["Well controlled","Suboptimal","Poor control"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Gastroenterology
const SCHEMA_GASTRO = {
  title: "Gastroenterology Visit",
  steps: [
    {
      id: "gi-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Abdominal pain, diarrhea, GERD…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
      ],
    },
    {
      id: "gi-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pain_location", label: "Pain Location", type: FIELD_TYPES.SELECT, options: ["RUQ","LUQ","RLQ","LLQ","Epigastric","Diffuse","None"] },
        { id: "bowel_habits", label: "Bowel Habits", type: FIELD_TYPES.MULTISELECT, options: ["Constipation","Diarrhea","Steatorrhea","Normal"] },
        { id: "alarm", label: "Alarm Features", type: FIELD_TYPES.MULTISELECT, options: ["GI bleeding","Weight loss","Anemia","Nocturnal symptoms","Dysphagia"] },
        { id: "pmh", label: "GI PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "PUD, IBD, gallstones, hepatitis…" },
        { id: "meds", label: "Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "NSAIDs, PPIs, steroids, antibiotics…" },
      ],
    },
    {
      id: "gi-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "abd_exam", label: "Abdominal Exam", type: FIELD_TYPES.MULTISELECT, options: ["Soft","Tender","Guarding","Rebound","Distension","Organomegaly","Murphy +"] },
        { id: "stool", label: "Stool Appearance (if reported)", type: FIELD_TYPES.SELECT, options: ["Normal","Occult blood suspected","Melena","Hematochezia"] },
      ],
    },
    {
      id: "gi-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP/LFTs","CRP/ESR","H. pylori Ag","Stool studies","Lipase/Amylase"] },
        { id: "imaging", label: "Imaging/Endoscopy", type: FIELD_TYPES.MULTISELECT, options: ["Abdominal US","CT Abd/Pelvis","EGD","Colonoscopy","MRCP","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Hematology
const SCHEMA_HEMATOLOGY = {
  title: "Hematology Visit",
  steps: [
    {
      id: "heme-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Anemia, bruising, bleeding, thrombosis…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
      ],
    },
    {
      id: "heme-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "bleeding_hist", label: "Bleeding History", type: FIELD_TYPES.MULTISELECT, options: ["Epistaxis","Gum bleed","Menorrhagia","Easy bruising","Post-op bleeding","None"] },
        { id: "thrombo_risk", label: "Thrombosis Risk", type: FIELD_TYPES.MULTISELECT, options: ["Immobilization","OCP/HRT","Malignancy","FHx VTE","Recent surgery"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "Anemia, malignancy, transfusions…" },
        { id: "meds", label: "Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "Anticoagulants, antiplatelets, chemo…" },
      ],
    },
    {
      id: "heme-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "exam", label: "Key Findings", type: FIELD_TYPES.MULTISELECT, options: ["Pallor","Petechiae","Purpura","Hepatosplenomegaly","Lymphadenopathy","Normal"] },
      ],
    },
    {
      id: "heme-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC + smear","Iron studies","B12/Folate","Coags (PT/aPTT)","D-dimer","LDH/Retic"] },
        { id: "imaging", label: "Imaging/Procedures", type: FIELD_TYPES.MULTISELECT, options: ["US abdomen","CT","Bone marrow biopsy","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Infectious Disease
const SCHEMA_ID = {
  title: "Infectious Disease Visit",
  steps: [
    {
      id: "id-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Fever, sepsis workup, post-travel…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
      ],
    },
    {
      id: "id-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "exposures", label: "Exposures", type: FIELD_TYPES.MULTISELECT, options: ["Travel","Sick contacts","Animal/insect","Food/water","Healthcare"] },
        { id: "immuno", label: "Immunocompromised", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "abx_history", label: "Recent Antibiotics", type: FIELD_TYPES.TEXTAREA },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "HIV, TB, hepatitis…" },
      ],
    },
    {
      id: "id-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "hemodynamics", label: "Hemodynamics", type: FIELD_TYPES.MULTISELECT, options: ["Stable","Tachycardic","Hypotensive","Tachypneic","Hypoxic"] },
        { id: "focus", label: "Probable Focus", type: FIELD_TYPES.MULTISELECT, options: ["Respiratory","GI","GU","CNS","Skin/soft tissue","Unknown"] },
      ],
    },
    {
      id: "id-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","CRP/ESR","Blood cultures","Urinalysis/culture","Viral panel","Procalcitonin"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["CXR","CT","US","MRI","None"] },
        { id: "isolation", label: "Isolation Precautions", type: FIELD_TYPES.SELECT, options: ["None","Droplet","Contact","Airborne"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Nephrology (CKD/AKI/HTN)
const SCHEMA_NEPH = {
  title: "Nephrology Visit",
  steps: [
    {
      id: "neph-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
      ],
    },
    {
      id: "neph-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "ckd_stage", label: "Known CKD Stage", type: FIELD_TYPES.SELECT, options: ["Unknown","G1","G2","G3a","G3b","G4","G5"] },
        { id: "proteinuria", label: "Proteinuria/Albuminuria", type: FIELD_TYPES.SELECT, options: ["Unknown","A1","A2","A3"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "DM, HTN, stones, GN…" },
        { id: "meds", label: "Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "ACEi/ARB, diuretics, nephrotoxins…" },
      ],
    },
    {
      id: "neph-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "volume_status", label: "Volume Status", type: FIELD_TYPES.SELECT, options: ["Euvolemic","Hypovolemic","Hypervolemic"] },
        { id: "edema", label: "Edema", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
      ],
    },
    {
      id: "neph-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["BMP/eGFR","UACR","Urinalysis","Electrolytes","PTH/Vit D","CBC"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Renal US","CT KUB","Doppler","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Pulmonology (asthma/COPD/infections)
const SCHEMA_PULMO = {
  title: "Pulmonology Visit",
  steps: [
    {
      id: "pulmo-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Dyspnea, cough, wheeze…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "smoking", label: "Smoking", type: FIELD_TYPES.SELECT, options: SMOKING_STATUS },
        { id: "spo2", label: "SpO₂", type: FIELD_TYPES.NUMBER, unit: "%" },
      ],
    },
    {
      id: "pulmo-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "asthma_copd", label: "Known Asthma/COPD", type: FIELD_TYPES.SELECT, options: ["None","Asthma","COPD","Overlap/Unknown"] },
        { id: "exacerbations", label: "Recent Exacerbations", type: FIELD_TYPES.SELECT, options: ["None","1","2","≥3"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "TB, bronchiectasis, ILD…" },
        { id: "meds", label: "Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "SABA/LABA/LAMA, ICS…" },
      ],
    },
    {
      id: "pulmo-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "work_of_breathing", label: "Work of Breathing", type: FIELD_TYPES.SELECT, options: ["Normal","Mild ↑","Moderate ↑","Severe ↑"] },
        { id: "wheeze", label: "Wheeze", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "rales", label: "Crackles", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
      ],
    },
    {
      id: "pulmo-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CRP/ESR","ABG/VBG","IgE/Eos"] },
        { id: "imaging", label: "Imaging/Tests", type: FIELD_TYPES.MULTISELECT, options: ["CXR","HRCT","Spirometry","Peak flow","None"] },
        { id: "severity", label: "Severity", type: FIELD_TYPES.SELECT, options: SEVERITY },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Rheumatology
const SCHEMA_RHEUM = {
  title: "Rheumatology Visit",
  steps: [
    {
      id: "rheum-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Joint pain, swelling, stiffness…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
      ],
    },
    {
      id: "rheum-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "distribution", label: "Joint Distribution", type: FIELD_TYPES.SELECT, options: ["Large joints","Small joints","Axial","Widespread"] },
        { id: "systemic", label: "Systemic Features", type: FIELD_TYPES.MULTISELECT, options: ["Rash","Photosensitivity","Oral ulcers","Raynaud","Uveitis","None"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "RA, SLE, PsA, gout…" },
        { id: "meds", label: "Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "NSAIDs, steroids, DMARDs, biologics…" },
      ],
    },
    {
      id: "rheum-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "joint_exam", label: "Joint Exam", type: FIELD_TYPES.MULTISELECT, options: ["Tender","Swollen","Warm","Deformity","Normal"] },
        { id: "skin", label: "Skin/Nails", type: FIELD_TYPES.MULTISELECT, options: ["Psoriatic plaques","Nail pitting","Malar rash","Gottron papules","Normal"] },
      ],
    },
    {
      id: "rheum-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["ESR/CRP","RF/anti-CCP","ANA/ENA","Uric acid","HLA-B27"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["X-ray","US joints","MRI","DEXA","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Orthopedics (injury / pain)
const SCHEMA_ORTHO = {
  title: "Orthopedics Visit",
  steps: [
    {
      id: "ortho-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "side", label: "Side", type: FIELD_TYPES.SELECT, options: ["Right","Left","Bilateral","Midline"] },
        { id: "mechanism", label: "Mechanism of Injury", type: FIELD_TYPES.SELECT, options: ["Fall","Twist","Crush","Road traffic","Sports","Overuse","Unknown"] },
        { id: "pain_scale", label: "Pain Scale (0–10)", type: FIELD_TYPES.SELECT, options: PAIN_SCALE },
      ],
    },
    {
      id: "ortho-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "weight_bearing", label: "Weight Bearing Possible", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Open wound","Deformity","Neuro deficit","Severe swelling","Fever"] },
        { id: "pmh", label: "Relevant PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "Osteoporosis, previous fractures…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "ortho-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "inspection", label: "Inspection", type: FIELD_TYPES.MULTISELECT, options: ["Swelling","Ecchymosis","Deformity","Open wound","Normal"] },
        { id: "palpation", label: "Palpation Tenderness", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "rom", label: "Range of Motion", type: FIELD_TYPES.SELECT, options: ["Full","Reduced","Severely limited"] },
        { id: "neurovascular", label: "Neurovascular Status Intact", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
      ],
    },
    {
      id: "ortho-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["X-ray","CT","MRI","Ultrasound","None"] },
        { id: "labs", label: "Labs (if indicated)", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CRP/ESR","Uric acid","None"] },
        { id: "immobilize", label: "Immobilization Needed", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// General Surgery
const SCHEMA_GENSURG = {
  title: "General Surgery Visit",
  steps: [
    {
      id: "gs-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Abdominal pain, hernia, breast lump…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "gs-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Peritonitis signs","GI bleeding","Sepsis","Obstruction"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "Previous surgeries, malignancy…" },
        { id: "meds", label: "Meds/Anticoagulants", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "gs-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "abd_exam", label: "Abdominal Exam", type: FIELD_TYPES.MULTISELECT, options: ["Tender","Guarding","Rebound","Mass","Hernia","Normal"] },
        { id: "wound", label: "Wound/Scar", type: FIELD_TYPES.SELECT, options: ["None","Healed scar","Infected","Dehisced"] },
      ],
    },
    {
      id: "gs-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP/LFTs","CRP/ESR","Coags"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Abdominal US","CT Abd/Pelvis","Mammogram/US","HIDA","None"] },
        { id: "op_need", label: "Operative Need", type: FIELD_TYPES.SELECT, options: ["Not indicated","Urgent","Elective—booked"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Urology
const SCHEMA_URO = {
  title: "Urology Visit",
  steps: [
    {
      id: "uro-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Dysuria, frequency, hematuria, stones…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
      ],
    },
    {
      id: "uro-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "luts", label: "LUTS", type: FIELD_TYPES.MULTISELECT, options: ["Frequency","Urgency","Nocturia","Weak stream","Straining","Incomplete emptying"] },
        { id: "stone_hist", label: "Stone History", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "BPH, UTIs, malignancy…" },
      ],
    },
    {
      id: "uro-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "abd_flank", label: "Abd/Flank Exam", type: FIELD_TYPES.MULTISELECT, options: ["CVA tenderness","Suprapubic tender","Mass","Normal"] },
        { id: "dre", label: "DRE (if indicated)", type: FIELD_TYPES.SELECT, options: ["Not done","Normal","Enlarged","Nodular","Tender"] },
      ],
    },
    {
      id: "uro-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["Urinalysis/culture","PSA","BMP","Stone analysis"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["US KUB","CT KUB","Cystoscopy","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Neurosurgery
const SCHEMA_NEUROSURG = {
  title: "Neurosurgery Visit",
  steps: [
    {
      id: "ns-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Back pain with radiculopathy, tumor consult, trauma follow-up…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "ns-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Saddle anesthesia","Urinary retention","Severe weakness","Acute neuro deficit"] },
        { id: "pmh", label: "PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "Spine surgery, malignancy, infection…" },
      ],
    },
    {
      id: "ns-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "neuro_exam", label: "Neuro/Spine Exam", type: FIELD_TYPES.MULTISELECT, options: ["Motor deficit","Sensory loss","Reflex changes","Gait abnormality","Normal"] },
        { id: "pain_scale", label: "Pain Scale (0–10)", type: FIELD_TYPES.SELECT, options: PAIN_SCALE },
      ],
    },
    {
      id: "ns-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["MRI brain","MRI spine","CT head","CT spine","Angio","None"] },
        { id: "op_consider", label: "Operative Consideration", type: FIELD_TYPES.SELECT, options: ["Not indicated","Elective","Urgent"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Cardiothoracic Surgery
const SCHEMA_CTS = {
  title: "Cardiothoracic Surgery Visit",
  steps: [
    {
      id: "cts-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Valve disease, CAD surgical eval, lung mass…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "cts-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "cardio_history", label: "Cardiac/Pulm History", type: FIELD_TYPES.TEXTAREA, placeholder: "MI, HF, COPD, prior thoracic surgery…" },
        { id: "functional", label: "Functional Class", type: FIELD_TYPES.SELECT, options: ["NYHA I","NYHA II","NYHA III","NYHA IV"] },
      ],
    },
    {
      id: "cts-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "cardiac_exam", label: "Cardiac Exam", type: FIELD_TYPES.MULTISELECT, options: ["Murmur","Edema","JVP ↑","Normal"] },
        { id: "resp_exam", label: "Respiratory Exam", type: FIELD_TYPES.MULTISELECT, options: ["Wheeze","Crackles","Decreased AE","Normal"] },
      ],
    },
    {
      id: "cts-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "tests", label: "Key Tests", type: FIELD_TYPES.MULTISELECT, options: ["Echo","Coronary angiography","CT chest","PFTs","PET-CT"] },
        { id: "op_plan", label: "Operative Plan", type: FIELD_TYPES.SELECT, options: ["Not indicated","CABG","Valve","Lobectomy","Other"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Dermatology (rash / lesion)
const SCHEMA_DERM = {
  title: "Dermatology Visit",
  steps: [
    {
      id: "derm-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "duration", label: "Duration", type: FIELD_TYPES.SELECT, options: DURATION_GENERAL },
      ],
    },
    {
      id: "derm-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pruritus", label: "Pruritus (itching)", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "triggers", label: "Triggers", type: FIELD_TYPES.MULTISELECT, options: ["Heat","Sweat","Sun","Food","Detergent","Stress","Unknown"] },
        { id: "allergies", label: "Allergies/Atopy", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current/Recent Topicals/Systemics", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "derm-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "distribution", label: "Distribution", type: FIELD_TYPES.MULTISELECT, options: ["Face","Trunk","Extensors","Flexors","Palms/Soles","Scalp","Generalized"] },
        { id: "morphology", label: "Morphology", type: FIELD_TYPES.MULTISELECT, options: ["Macules","Papules","Plaques","Vesicles","Pustules","Nodules","Scales","Crusts"] },
        { id: "secondary", label: "Secondary Changes", type: FIELD_TYPES.MULTISELECT, options: ["Excoriations","Lichenification","Fissures","Ulceration","None"] },
        { id: "koh", label: "KOH Test Performed", type: FIELD_TYPES.TOGGLE },
        { id: "dermoscopy", label: "Dermoscopy Performed", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "derm-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs (if needed)", type: FIELD_TYPES.MULTISELECT, options: ["CBC","IgE","CRP/ESR","Bacterial culture","Fungal culture","Patch test"] },
        { id: "biopsy", label: "Biopsy Considered", type: FIELD_TYPES.TOGGLE },
        { id: "route", label: "Treatment Route", type: FIELD_TYPES.SELECT, options: ["Topical","Systemic","Phototherapy"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Neurology (headache/seizure)
const SCHEMA_NEURO = {
  title: "Neurology Visit",
  steps: [
    {
      id: "neuro-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "onset", label: "Onset", type: FIELD_TYPES.SELECT, options: ["Acute","Subacute","Chronic","Recurrent"] },
      ],
    },
    {
      id: "neuro-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "neuro_red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Sudden severe headache","Focal deficit","Fever/neck stiffness","Trauma","Immunosuppression"] },
        { id: "pmh", label: "Neurologic PMH", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "neuro-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "neuro_exam", label: "Neuro Exam Highlights", type: FIELD_TYPES.MULTISELECT, options: ["Normal","Cranial nerve deficit","Motor weakness","Sensory deficit","Ataxia","Aphasia"] },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
      ],
    },
    {
      id: "neuro-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["CT head","MRI brain","MRA/CTA","None"] },
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","CRP/ESR","TSH","B12"] },
        { id: "lp", label: "Lumbar Puncture Considered", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// ENT
const SCHEMA_ENT = {
  title: "ENT Visit",
  steps: [
    {
      id: "ent-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "ent-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "ear_symptoms", label: "Ear Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Otalgia","Otorrhea","Hearing loss","Tinnitus","Vertigo"] },
        { id: "nose_symptoms", label: "Nasal Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Congestion","Rhinorrhea","Epistaxis","Anosmia"] },
        { id: "throat_symptoms", label: "Throat Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Sore throat","Hoarseness","Dysphagia","Odynophagia"] },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "ent-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "otoscopy", label: "Otoscopy", type: FIELD_TYPES.SELECT, options: ["Normal","AOM signs","OME","TM perforation"] },
        { id: "nasal_exam", label: "Nasal Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Polyps","Deviated septum","Inflamed turbinates"] },
        { id: "throat_exam", label: "Throat Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Erythema","Exudates","Tonsillar hypertrophy"] },
      ],
    },
    {
      id: "ent-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["Throat swab","CBC","Allergy panel","None"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Sinus CT","Neck US","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Ophthalmology
const SCHEMA_OPHTH = {
  title: "Ophthalmology Visit",
  steps: [
    {
      id: "eye-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "eye", label: "Eye", type: FIELD_TYPES.SELECT, options: ["Right","Left","Both"] },
        { id: "duration", label: "Duration", type: FIELD_TYPES.SELECT, options: DURATION_SHORT },
      ],
    },
    {
      id: "eye-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "symptoms", label: "Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Redness","Pain","Photophobia","Discharge","Blurred vision","Floaters"] },
        { id: "contacts", label: "Contact Lens Use", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "trauma", label: "Recent Trauma", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "eye-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "visual_acuity", label: "Visual Acuity (if known)", type: FIELD_TYPES.TEXT, placeholder: "e.g., 6/9, 20/40" },
        { id: "fluorescein", label: "Fluorescein Stain Performed", type: FIELD_TYPES.TOGGLE },
        { id: "iop", label: "IOP Checked", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "eye-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs (if needed)", type: FIELD_TYPES.MULTISELECT, options: ["Culture swab","HSV PCR","None"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["B-scan US","OCT","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Family Medicine (broad primary care)
const SCHEMA_FAMILY = {
  title: "Family Medicine Visit",
  steps: [
    {
      id: "fm-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint / Reason for Visit", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
        { id: "bp", label: "BP", type: FIELD_TYPES.TEXT, placeholder: BP_PLACEHOLDER },
      ],
    },
    {
      id: "fm-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "chronic", label: "Chronic Conditions", type: FIELD_TYPES.MULTISELECT, options: ["HTN","DM","Dyslipidemia","Asthma/COPD","CKD","Depression/Anxiety"] },
        { id: "lifestyle", label: "Lifestyle", type: FIELD_TYPES.MULTISELECT, options: ["Diet","Exercise","Smoking","Alcohol","Sleep"] },
        { id: "meds", label: "Medications", type: FIELD_TYPES.TEXTAREA },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "fm-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "gen_exam", label: "General Exam", type: FIELD_TYPES.MULTISELECT, options: ["Normal","Ill-appearing","Weight loss","Edema"] },
      ],
    },
    {
      id: "fm-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "screening", label: "Screening", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","Lipid panel","HbA1c","TSH","FIT/Colonoscopy","Mammogram","Pap"] },
        { id: "notes", label: "Plan / Education", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Geriatrics
const SCHEMA_GERI = {
  title: "Geriatrics Visit",
  steps: [
    {
      id: "geri-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Concern", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
      ],
    },
    {
      id: "geri-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI / Functional Concerns", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "geri_syndromes", label: "Geriatric Syndromes", type: FIELD_TYPES.MULTISELECT, options: ["Falls","Frailty","Cognition","Polypharmacy","Incontinence","Depression"] },
        { id: "adl", label: "ADL/IADL Impairment", type: FIELD_TYPES.SELECT, options: ["None","Some","Significant"] },
        { id: "meds", label: "Meds (incl. high-risk)", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "geri-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "cog_screen", label: "Cognitive Screen (if done)", type: FIELD_TYPES.SELECT, options: ["Not done","Normal","Abnormal"] },
        { id: "gait", label: "Gait/Balance", type: FIELD_TYPES.SELECT, options: ["Normal","Unsteady","Assistive device"] },
      ],
    },
    {
      id: "geri-plan",
      title: "Tests & Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","TSH","B12","Vit D"] },
        { id: "safety", label: "Safety Plan", type: FIELD_TYPES.MULTISELECT, options: ["Falls prevention","Medication review","Caregiver support","Advance directives"] },
        { id: "notes", label: "Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Psychiatry
const SCHEMA_PSYCH = {
  title: "Psychiatry Visit",
  steps: [
    {
      id: "psych-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Presenting Problem", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "psych-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History / Current Episode", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "sx_clusters", label: "Symptom Clusters", type: FIELD_TYPES.MULTISELECT, options: ["Depression","Anxiety","Psychosis","Mania/Hypomania","PTSD","OCD"] },
        { id: "risk", label: "Risk Assessment", type: FIELD_TYPES.MULTISELECT, options: ["SI","HI","Self-harm","None"] },
        { id: "substance", label: "Substance Use", type: FIELD_TYPES.MULTISELECT, options: ["Alcohol","Cannabis","Stimulants","Opioids","Sedatives","None"] },
        { id: "meds", label: "Psych Meds", type: FIELD_TYPES.TEXTAREA },
        { id: "past_psych", label: "Past Psychiatric Hx", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "psych-exam",
      title: "Exam & MSE",
      fields: [
        { id: "mse", label: "Mental Status Exam", type: FIELD_TYPES.MULTISELECT, options: ["Appearance","Behavior","Speech","Mood/Affect","Thought content","Cognition","Insight/Judgment"] },
      ],
    },
    {
      id: "psych-plan",
      title: "Tests & Plan",
      fields: [
        { id: "labs", label: "Baseline Labs (if needed)", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","TSH","Lipid panel","HbA1c","ECG (QTc)"] },
        { id: "therapy", label: "Therapy", type: FIELD_TYPES.SELECT, options: ["Supportive","CBT","DBT","Family","None now"] },
        { id: "notes", label: "Treatment Plan / Safety", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Addiction Medicine
const SCHEMA_ADDICTION = {
  title: "Addiction Medicine Visit",
  steps: [
    {
      id: "addict-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Presenting Concern", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "addict-history",
      title: "History & Risk",
      fields: [
        { id: "substances", label: "Primary Substances", type: FIELD_TYPES.MULTISELECT, options: ["Alcohol","Opioids","Stimulants","Cannabis","Benzodiazepines","Other"] },
        { id: "pattern", label: "Pattern of Use", type: FIELD_TYPES.MULTISELECT, options: ["Daily","Binge","Occasional","Withdrawal hx"] },
        { id: "risks", label: "Risks", type: FIELD_TYPES.MULTISELECT, options: ["OD risk","Polysubstance","Unsafe injections","Co-occurring MH"] },
        { id: "meds", label: "Meds / MAT", type: FIELD_TYPES.TEXTAREA, placeholder: "Methadone, buprenorphine, naltrexone…" },
      ],
    },
    {
      id: "addict-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "withdrawal", label: "Withdrawal Signs", type: FIELD_TYPES.SELECT, options: ["None","Mild","Moderate","Severe"] },
      ],
    },
    {
      id: "addict-plan",
      title: "Tests & Plan",
      fields: [
        { id: "labs", label: "Labs/Screening", type: FIELD_TYPES.MULTISELECT, options: ["UDS","LFTs","HIV/HCV","CBC/CMP"] },
        { id: "mat_plan", label: "Treatment Path", type: FIELD_TYPES.SELECT, options: ["Detox","Outpatient MAT","Counseling/CBT","Inpatient rehab"] },
        { id: "notes", label: "Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Neonatology
const SCHEMA_NEO = {
  title: "Neonatology Visit",
  steps: [
    {
      id: "neo-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Primary Concern", type: FIELD_TYPES.TEXT, required: true, placeholder: "Jaundice, feeding issue, prematurity follow-up…" },
        { id: "age_days", label: "Age (days)", type: FIELD_TYPES.NUMBER, unit: "days", required: true },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX },
        { id: "ga", label: "Gestational Age at Birth", type: FIELD_TYPES.NUMBER, unit: "weeks" },
        { id: "bw", label: "Birth Weight", type: FIELD_TYPES.NUMBER, unit: "g" },
      ],
    },
    {
      id: "neo-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "HPI", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pregnancy", label: "Pregnancy/Delivery", type: FIELD_TYPES.MULTISELECT, options: ["Normal","C-section","Vacuum/Forceps","PROM","Maternal fever","GDM","Preeclampsia"] },
        { id: "feeding", label: "Feeding", type: FIELD_TYPES.SELECT, options: FEEDING },
        { id: "jaundice_risk", label: "Jaundice Risk", type: FIELD_TYPES.MULTISELECT, options: ["ABO/Rh incompatibility","Prematurity","Cephalohematoma","G6PD"] },
      ],
    },
    {
      id: "neo-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "vitals", label: "Vitals", type: FIELD_TYPES.MULTISELECT, options: ["Temp","RR","HR","SpO₂"] },
        { id: "exam", label: "Exam", type: FIELD_TYPES.MULTISELECT, options: ["Tone","Suck","Jaundice","Respiratory distress","Normal"] },
      ],
    },
    {
      id: "neo-plan",
      title: "Tests & Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["TSB/DB","CBC","CRP","Glucose"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["CXR","Cranial US","None"] },
        { id: "notes", label: "Plan Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Reproductive Medicine (IVF)
const SCHEMA_REPRO = {
  title: "Reproductive Medicine (IVF) Visit",
  steps: [
    {
      id: "repro-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Reason for Visit", type: FIELD_TYPES.TEXT, required: true, placeholder: "Infertility consult, cycle monitoring…" },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
      ],
    },
    {
      id: "repro-history",
      title: "History & Risk",
      fields: [
        { id: "infertility_dur", label: "Infertility Duration", type: FIELD_TYPES.SELECT, options: ["<1 year","1–2 years",">2 years"] },
        { id: "ob_gyn", label: "OB/GYN Hx", type: FIELD_TYPES.TEXTAREA, placeholder: "Cycles, endometriosis, fibroids, surgeries…" },
        { id: "male_factor", label: "Male Factor", type: FIELD_TYPES.SELECT, options: ["Unknown","Suspected","Confirmed","None"] },
        { id: "prior_tx", label: "Prior Treatments", type: FIELD_TYPES.MULTISELECT, options: ["Ovulation induction","IUI","IVF","ICSI","None"] },
        { id: "labs_prev", label: "Key Prior Labs", type: FIELD_TYPES.MULTISELECT, options: ["AMH","FSH/LH","TSH/Prolactin","Semen analysis"] },
      ],
    },
    {
      id: "repro-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "us_findings", label: "US Findings", type: FIELD_TYPES.MULTISELECT, options: ["Antral follicle count","Ovarian cyst","Fibroids","Normal"] },
      ],
    },
    {
      id: "repro-plan",
      title: "Tests & Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["AMH","FSH/LH","E2","Progesterone","TSH/Prolactin","Infectious screen"] },
        { id: "imaging", label: "Imaging/Procedures", type: FIELD_TYPES.MULTISELECT, options: ["HSG","HyCoSy","Sonohysterogram","None"] },
        { id: "plan", label: "Treatment Plan", type: FIELD_TYPES.SELECT, options: ["Expectant","Ovulation induction","IUI","IVF/ICSI","FET"] },
        { id: "notes", label: "Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Pulled earlier schemas re-used: SCHEMA_ORTHO, SCHEMA_DERM, SCHEMA_NEURO, SCHEMA_ENT, SCHEMA_OPHTH, SCHEMA_CARDIOLOGY, SCHEMA_OBGYN, SCHEMA_PEDIATRICS
// Add: Neurology already present; good.

// ---------------- Export map ----------------
export const SPECIALTY_SCHEMAS = {
  // Medicine
  cardiology: SCHEMA_CARDIOLOGY,
  endocrinology: SCHEMA_ENDOCRINOLOGY,
  gastroenterology: SCHEMA_GASTRO,
  hematology: SCHEMA_HEMATOLOGY,
  "infectious disease": SCHEMA_ID,
  nephrology: SCHEMA_NEPH,
  neurology: SCHEMA_NEURO,
  pulmonology: SCHEMA_PULMO,
  rheumatology: SCHEMA_RHEUM,
  // Surgery
  "general surgery": SCHEMA_GENSURG,
  orthopedics: SCHEMA_ORTHO,
  urology: SCHEMA_URO,
  neurosurgery: SCHEMA_NEUROSURG,
  "cardiothoracic surgery": SCHEMA_CTS,
  // Women & Children
  obgyn: SCHEMA_OBGYN,
  pediatrics: SCHEMA_PEDIATRICS,
    neonatology: SCHEMA_NEO,
    "reproductive medicine": SCHEMA_REPRO,
    "Addiction Medicine Visit": SCHEMA_ADDICTION,
    "Psychiatry Visit": SCHEMA_PSYCH,
    "Geriatrics": SCHEMA_GERI,
    "Family Medicine Visit": SCHEMA_FAMILY,
  dermatology: SCHEMA_DERM,
  ent: SCHEMA_ENT,
  ophthalmology: SCHEMA_OPHTH,

  }
export const DEFAULT_SCHEMA = SCHEMA_PEDIATRICS;
